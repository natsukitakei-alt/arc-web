import { ArcOwnerStore } from '../src/store.mjs';
import { seal } from '../src/security.mjs';
export function environment() {
  return { APP_ORIGIN: 'https://arc.example.workers.dev', SLACK_CLIENT_ID: '123.456', SLACK_APP_ID: 'AFAKE001',
    SLACK_OWNER_USER_ID: 'UFAKE001', SLACK_OWNER_TEAM_ID: 'TFAKE001', SLACK_CLIENT_SECRET: 'fictional-client',
    SLACK_SIGNING_SECRET: 'fictional-signing', ARC_SECRET_BASE64: btoa('01234567890123456789012345678901') };
}
export async function makeStore() {
  const env = environment(); const saved = new Map(); const ctx = { blockConcurrencyWhile: work => work(), storage: {
    get: async key => structuredClone(saved.get(key)), put: async (key, value) => saved.set(key, structuredClone(value)),
    setAlarm: async () => {}, deleteAlarm: async () => {} } };
  const owner = new ArcOwnerStore(ctx, env); await owner.ready;
  env.ARC_STORE = { idFromName: name => name, get: () => ({ fetch: r => owner.fetch(r) }) };
  env.ASSETS = { fetch: async () => new Response('public screen') };
  return { env, owner, saved };
}
export async function install(owner, env, hash = 'fake-session') {
  const credentials = await seal({ access: 'fictional-access', refresh: null, expiresAt: null }, env, 'slack-token');
  await owner.route('/install', { credentials, hash, host: 'example.slack.com', generation: owner.data.generation }); return owner.data.generation;
}
export function message(text, user = 'UOTHER01', secondsAgo = 60, fields = {}) {
  return { type: 'message', user, text, ts: (Math.floor(Date.now() / 1000) - secondsAgo) + '.000001',
    channel: 'CFAKE001', channel_type: 'channel', ...fields };
}
export function envelope(event, id = 'EvFAKE00001') {
  return { type: 'event_callback', api_app_id: 'AFAKE001', team_id: 'TFAKE001', event_id: id,
    authorizations: [{ is_bot: false, user_id: 'UFAKE001', team_id: 'TFAKE001' }], event };
}
export async function signedRequest(payload, env, stamp = Math.floor(Date.now() / 1000), raw = JSON.stringify(payload)) {
  const encoder = new TextEncoder(); const key = await crypto.subtle.importKey('raw', encoder.encode(env.SLACK_SIGNING_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode('v0:' + stamp + ':' + raw)));
  const signature = 'v0=' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return new Request(env.APP_ORIGIN + '/api/slack/events', { method: 'POST', body: raw,
    headers: { 'x-slack-signature': signature, 'x-slack-request-timestamp': String(stamp) } });
}
