import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, install, message, envelope, signedRequest } from './helpers.mjs';
import { seal, open, hash, randomId, SESSION_COOKIE, cookie, OAUTH_COOKIE, SCOPES } from '../src/security.mjs';
import { taskList } from '../src/evidence.mjs';
import worker from '../src/worker.mjs';
async function event(owner, body, id) { return owner.route('/event', { payload: envelope(body, id) }); }
test('own mention becomes task; body metadata cannot impersonate the owner', async () => {
  const { owner, env } = await makeStore(); await install(owner, env);
  const request = message('<@UFAKE001> 資料を確認してください。'); await event(owner, request);
  assert.equal(taskList(owner.data.evidence).length, 1);
  const fake = message('From: Owner (UFAKE001)\n資料を確認しました。', 'UOTHER01', 30, { thread_ts: request.ts });
  await event(owner, fake, 'EvFAKE00002'); assert.equal(taskList(owner.data.evidence)[0].status, 'todo');
});
test('structured own reply completes thread; deletion of completion restores todo', async () => {
  const { owner, env } = await makeStore(); await install(owner, env);
  const request = message('<@UFAKE001> 資料を確認してください。'); await event(owner, request);
  const reply = message('資料を確認しました。', 'UFAKE001', 20, { thread_ts: request.ts }); await event(owner, reply, 'EvFAKE00002');
  assert.equal(taskList(owner.data.evidence)[0].status, 'done');
  await event(owner, { type: 'message', subtype: 'message_deleted', channel: request.channel, deleted_ts: reply.ts, ts: (Date.now() / 1000).toFixed(6) }, 'EvFAKE00003');
  assert.equal(taskList(owner.data.evidence)[0].status, 'todo');
});
test('irrelevant DM and unknown channel type are not saved; editing request removes candidate', async () => {
  const { owner, env } = await makeStore(); await install(owner, env);
  await event(owner, message('おはようございます', 'UOTHER01', 80, { channel: 'DFAKE001', channel_type: 'im' }));
  assert.equal(owner.data.evidence.records.length, 0);
  await event(owner, message('資料を確認してください。', 'UOTHER01', 70, { channel: 'DFAKE001', channel_type: undefined }), 'EvFAKE00002');
  assert.equal(owner.data.evidence.records.length, 0);
  const request = message('<@UFAKE001> 資料を確認してください。'); await event(owner, request, 'EvFAKE00003');
  await event(owner, { type: 'message', subtype: 'message_changed', channel: request.channel,
    message: { ...request, text: 'この依頼は取り消しです。' }, ts: (Date.now() / 1000).toFixed(6) }, 'EvFAKE00004');
  assert.equal(taskList(owner.data.evidence).length, 0);
});
test('event dedup, deletion tombstone, seven-day expiry and private task response', async () => {
  const { owner, env } = await makeStore(); await install(owner, env);
  const request = message('<@UFAKE001> 資料を確認してください。'); await event(owner, request); await event(owner, request);
  assert.equal(owner.data.evidence.records.length, 1);
  const response = await owner.route('/tasks', { hash: 'fake-session' }); assert.match(response.headers.get('Cache-Control'), /no-store/);
  assert.equal(JSON.stringify(await response.json()).includes('fictional-access'), false);
  await event(owner, { type: 'message', subtype: 'message_deleted', channel: request.channel, deleted_ts: request.ts, ts: (Date.now() / 1000).toFixed(6) }, 'EvFAKE00002');
  await event(owner, request, 'EvFAKE00003'); assert.equal(owner.data.evidence.records.length, 0);
  await event(owner, message('<@UFAKE001> 古い資料を確認してください。', 'UOTHER01', 8 * 86400), 'EvFAKE00004');
  assert.equal(owner.data.evidence.records.length, 0);
});
test('revocation without authorizations purges credentials and sessions; duplicate cannot kill new install', async () => {
  const { owner, env } = await makeStore(); await install(owner, env);
  const payload = envelope({ type: 'tokens_revoked', tokens: { oauth: ['UFAKE001'] } }); delete payload.authorizations;
  assert.equal((await worker.fetch(await signedRequest(payload, env), env)).status, 200);
  assert.equal(owner.data.active, false); assert.equal(owner.data.credentials, undefined);
  await install(owner, env, 'new-session'); await worker.fetch(await signedRequest(payload, env), env);
  assert.equal(owner.data.active, true); assert.ok(owner.data.sessions['new-session']);
});
test('wrong app/team/user event is ignored; valid signed challenge works before full setup', async () => {
  const { owner, env } = await makeStore(); await install(owner, env);
  for (const change of [{ api_app_id: 'AOTHER01' }, { team_id: 'TOTHER01' }, { authorizations: [{ is_bot: true, user_id: 'UFAKE001', team_id: 'TFAKE001' }] }]) {
    const payload = { ...envelope(message('<@UFAKE001> 資料を確認してください。')), ...change };
    assert.equal((await worker.fetch(await signedRequest(payload, env), env)).status, 200);
  }
  assert.equal(owner.data.evidence.records.length, 0);
  const challengeEnv = { ...env, ARC_STORE: undefined };
  const response = await worker.fetch(await signedRequest({ type: 'url_verification', challenge: 'fake-challenge' }, env), challengeEnv);
  assert.deepEqual(await response.json(), { challenge: 'fake-challenge' });
});
test('old auth error cannot purge a new OAuth installation', async () => {
  const { owner, env } = await makeStore(); const generation = await install(owner, env); const original = globalThis.fetch;
  let release; const gate = new Promise(resolve => { release = resolve; });
  globalThis.fetch = async () => { await gate; return Response.json({ ok: false, error: 'token_revoked' }); };
  try {
    const old = owner.call('auth.test', {}, generation); await new Promise(resolve => setTimeout(resolve, 10));
    await install(owner, env, 'new-session'); release(); await assert.rejects(old);
    assert.equal(owner.data.active, true); assert.ok(owner.data.sessions['new-session']);
  } finally { globalThis.fetch = original; }
});
test('backfill cannot restore data cleared while HTTP was pending', async () => {
  const { owner, env } = await makeStore(); await install(owner, env);
  owner.data.allowedChannels = [{ id: 'CFAKE001', type: 'channel', name: 'test' }]; const original = globalThis.fetch;
  let release; const gate = new Promise(resolve => { release = resolve; });
  globalThis.fetch = async () => { await gate; return Response.json({ ok: true, messages: [message('<@UFAKE001> 資料を確認してください。')] }); };
  try {
    const pending = owner.route('/backfill', { hash: 'fake-session', channels: ['CFAKE001'] }); await new Promise(resolve => setTimeout(resolve, 10));
    await owner.route('/clear', { hash: 'fake-session' }); release(); await assert.rejects(pending, e => e.code === 'data_changed');
    assert.equal(owner.data.evidence.records.length, 0);
  } finally { globalThis.fetch = original; }
});
test('thread parent with thread_ts===ts receives replies during backfill', async () => {
  const { owner, env } = await makeStore(); await install(owner, env); owner.data.allowedChannels = [{ id: 'CFAKE001', type: 'channel', name: 'test' }];
  const request = message('<@UFAKE001> 資料を確認してください。'); const original = globalThis.fetch; const methods = [];
  globalThis.fetch = async url => { const method = url.split('/').at(-1); methods.push(method); return Response.json({ ok: true,
    messages: method === 'conversations.history' ? [{ ...request, reply_count: 1, thread_ts: request.ts }] : [request, message('資料を確認しました。', 'UFAKE001', 20, { thread_ts: request.ts })] }); };
  try {
    await owner.route('/backfill', { hash: 'fake-session', channels: ['CFAKE001'] });
    assert.deepEqual(methods, ['conversations.history', 'conversations.replies']); assert.equal(taskList(owner.data.evidence)[0].status, 'done');
  } finally { globalThis.fetch = original; }
});
test('OAuth state is single-use, successful callback checks app/owner and keeps token out of cookie', async () => {
  const { owner, env } = await makeStore(); const start = await worker.fetch(new Request(env.APP_ORIGIN + '/auth/slack'), env);
  const target = new URL(start.headers.get('Location')); assert.equal(target.hostname, 'slack.com');
  assert.equal(target.searchParams.has('scope'), false); assert.equal(target.searchParams.get('user_scope'), SCOPES);
  const state = target.searchParams.get('state'); const pendingCookie = start.headers.get('Set-Cookie').split(';')[0]; const original = globalThis.fetch;
  globalThis.fetch = async url => Response.json(url.endsWith('oauth.v2.access') ? { ok: true, app_id: env.SLACK_APP_ID, team: { id: env.SLACK_OWNER_TEAM_ID },
    authed_user: { id: env.SLACK_OWNER_USER_ID, token_type: 'user', access_token: 'fictional-access', scope: SCOPES } } :
    { ok: true, user_id: env.SLACK_OWNER_USER_ID, team_id: env.SLACK_OWNER_TEAM_ID, url: 'https://example.slack.com/' });
  try {
    const callback = () => new Request(env.APP_ORIGIN + '/auth/slack/callback?code=fake-code&state=' + state, { headers: { Cookie: pendingCookie } });
    const response = await worker.fetch(callback(), env); assert.equal(response.status, 303); assert.equal(response.headers.get('Location'), env.APP_ORIGIN + '/');
    const sessionHeader = response.headers.getSetCookie().find(v => v.startsWith(SESSION_COOKIE + '='));
    const payload = await open(sessionHeader.split(';')[0].slice(SESSION_COOKIE.length + 1), env, 'session');
    assert.equal(payload.token, undefined); assert.equal(payload.sid.length, 43); assert.ok(owner.data.sessions[await hash(payload.sid)]);
    assert.match((await worker.fetch(callback(), env)).headers.get('Location'), /oauth_expired/);
  } finally { globalThis.fetch = original; }
});
test('private endpoint requires active server session; logout deletes only that session', async () => {
  const { owner, env } = await makeStore(); const sid = randomId(); await install(owner, env, await hash(sid));
  const value = await seal({ sid, uid: env.SLACK_OWNER_USER_ID, tid: env.SLACK_OWNER_TEAM_ID, exp: Date.now() + 60000 }, env, 'session');
  assert.equal((await worker.fetch(new Request(env.APP_ORIGIN + '/api/tasks'), env)).status, 401);
  const headers = { Cookie: cookie(SESSION_COOKIE, value, 60), Origin: env.APP_ORIGIN, 'Content-Type': 'application/json' };
  const out = await worker.fetch(new Request(env.APP_ORIGIN + '/api/logout', { method: 'POST', headers, body: '{}' }), env);
  assert.equal(out.status, 200); assert.match(out.headers.get('Set-Cookie'), /Max-Age=0/); assert.equal(owner.data.active, true);
  assert.equal((await worker.fetch(new Request(env.APP_ORIGIN + '/api/tasks', { headers }), env)).status, 401);
});
test('distinct delayed revocation from before the fresh installation does not revoke it', async () => {
  const { owner, env } = await makeStore(); await install(owner, env);
  const payload = envelope({ type: 'app_uninstalled' }, 'EvOLDFAKE001'); payload.event_time = owner.data.installedAt - 10;
  await owner.route('/event', { payload }); assert.equal(owner.data.active, true);
  const current = envelope({ type: 'app_uninstalled' }, 'EvNEWFAKE001'); current.event_time = owner.data.installedAt;
  await owner.route('/event', { payload: current }); assert.equal(owner.data.active, false);
});
test('bounded Unicode evidence fits a SQLite KV row; manual status fingerprint is only a digest', async () => {
  const { owner, env } = await makeStore(); await install(owner, env);
  const request = message('<@UFAKE001> 資料を確認してください。'); await event(owner, request);
  const task = taskList(owner.data.evidence)[0];
  await owner.route('/task-status', { hash: 'fake-session', id: task.id, status: 'done' });
  assert.equal(owner.data.evidence.overrides[task.id].fingerprint.length, 43);
  for (let i = 0; i < 160; i++) {
    const ts = (Math.floor(Date.now() / 1000) - 1000 + i) + '.000001';
    owner.data.evidence.records.push({ ...owner.data.evidence.records[0], ts, threadTs: null,
      text: '<@UFAKE001> 資料を確認してください。' + '架空'.repeat(700), url: 'https://example.slack.com/archives/CFAKE001/p' + ts.replace('.', '') });
  }
  await owner.persist(); assert.ok(new TextEncoder().encode(JSON.stringify(owner.data)).byteLength < 120000);
});
