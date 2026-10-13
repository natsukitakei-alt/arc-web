import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, signedRequest } from './helpers.mjs';
import { seal, open, randomId, hash, session, cookie, readCookie, SESSION_COOKIE, configured, boundedBody,
  sameOriginJson, verifiedSlackBody, slackApi, SCOPES } from '../src/security.mjs';
test('encrypted payload is randomized and bound to purpose and origin', async () => {
  const env = environment(); const first = await seal({ sid: 'fictional' }, env, 'session');
  assert.deepEqual(await open(first, env, 'session'), { sid: 'fictional' });
  assert.notEqual(first, await seal({ sid: 'fictional' }, env, 'session'));
  await assert.rejects(open(first, env, 'oauth'));
  await assert.rejects(open(first, { ...env, APP_ORIGIN: 'https://other.example' }, 'session'));
  await assert.rejects(open(first.slice(0, -1), env, 'session'));
});
test('session authenticates exact owner with a hashed opaque sid; expired/wrong owner fails', async () => {
  const env = environment(); const sid = randomId(); const value = { sid, exp: Date.now() + 60000, uid: env.SLACK_OWNER_USER_ID, tid: env.SLACK_OWNER_TEAM_ID };
  const request = token => new Request(env.APP_ORIGIN, { headers: { Cookie: cookie(SESSION_COOKIE, token, 60) } });
  assert.equal(await session(request(await seal(value, env, 'session')), env), await hash(sid));
  await assert.rejects(session(request(await seal({ ...value, uid: 'UOTHER01' }, env, 'session')), env));
  await assert.rejects(session(request(await seal({ ...value, exp: Date.now() - 1 }, env, 'session')), env));
  assert.equal(readCookie(new Request(env.APP_ORIGIN, { headers: { Cookie: SESSION_COOKIE + '=a; ' + SESSION_COOKIE + '=b' } }), SESSION_COOKIE), null);
});
test('configuration rejects invalid encryption key and HTTP origin', () => {
  const env = { ...environment(), ARC_STORE: {} }; assert.equal(configured(env), true);
  assert.equal(configured({ ...env, ARC_SECRET_BASE64: 'invalid' }), false);
  assert.equal(configured({ ...env, APP_ORIGIN: 'http://arc.example' }), false);
});
test('bounded body rejects actual streamed byte overflow and a stalled reader', async () => {
  const oversized = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(8)); c.close(); } }));
  await assert.rejects(boundedBody(oversized, 4), e => e.status === 413);
  const stalled = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1)); } }));
  await assert.rejects(boundedBody(stalled, 4, 20), e => e.code === 'body_timeout');
});
test('POST JSON rejects missing/cross origin and non-JSON data', async () => {
  const env = environment(); const req = headers => new Request(env.APP_ORIGIN + '/api/clear', { method: 'POST', headers, body: '{}' });
  await assert.rejects(sameOriginJson(req({ 'Content-Type': 'application/json' }), env), e => e.status === 403);
  await assert.rejects(sameOriginJson(req({ Origin: 'https://other.example', 'Content-Type': 'application/json' }), env));
  await assert.rejects(sameOriginJson(req({ Origin: env.APP_ORIGIN, 'Content-Type': 'text/plain' }), env), e => e.status === 415);
  assert.deepEqual(await sameOriginJson(req({ Origin: env.APP_ORIGIN, 'Content-Type': 'application/json' }), env), {});
});
test('Slack signature binds exact raw bytes and rejects replay timestamps', async () => {
  const env = environment(); const payload = { type: 'url_verification', challenge: 'fake' };
  assert.deepEqual(await verifiedSlackBody(await signedRequest(payload, env), env), payload);
  await assert.rejects(verifiedSlackBody(await signedRequest(payload, env, Math.floor(Date.now() / 1000) - 301), env));
  const request = await signedRequest(payload, env); const tampered = new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(payload) + ' ' });
  await assert.rejects(verifiedSlackBody(tampered, env), e => e.code === 'signature_rejected');
});
test('OAuth has no empty Bearer header; Slack 429 honors Retry-After; expiration is revocation', async () => {
  let headers;
  await slackApi('oauth.v2.access', '', {}, async (_, init) => { headers = init.headers; return Response.json({ ok: true }); });
  assert.equal(headers.Authorization, undefined);
  await assert.rejects(slackApi('auth.test', 'fake', {}, async () => new Response('', { status: 429, headers: { 'Retry-After': '120' } })), e => e.retryAfter === 120);
  await assert.rejects(slackApi('auth.test', 'fake', {}, async () => Response.json({ ok: false, error: 'token_expired' })), e => e.code === 'slack_revoked');
  assert.equal(SCOPES.includes('write'), false);
});
