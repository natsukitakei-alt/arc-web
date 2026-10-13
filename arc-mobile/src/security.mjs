const encoder = new TextEncoder();
export const SESSION_COOKIE = '__Host-arc-session';
export const OAUTH_COOKIE = '__Host-arc-oauth';
export const SESSION_SECONDS = 7 * 86400;
export const USER_ID = /^[UW][A-Z0-9]{6,20}$/;
export const TEAM_ID = /^T[A-Z0-9]{6,20}$/;
export const CHANNEL_ID = /^[CDG][A-Z0-9]{6,20}$/;
export const TS = /^\d{10,13}\.\d{1,6}$/;
export const SCOPES = 'channels:read,groups:read,im:read,mpim:read,channels:history,groups:history,im:history,mpim:history';

export class ArcError extends Error {
  constructor(code, status = 400, retryAfter = 0) { super(code); this.code = code; this.status = status; this.retryAfter = retryAfter; }
}
export function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decode64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 12000) throw new ArcError('invalid_session', 401);
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
  if (b64url(bytes) !== value) throw new ArcError('invalid_session', 401);
  return bytes;
}
export function randomId() { return b64url(crypto.getRandomValues(new Uint8Array(32))); }
export async function hash(value) { return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))); }
export function configured(env) {
  try {
    const origin = new URL(env.APP_ORIGIN);
    const secret = atob(env.ARC_SECRET_BASE64 || '');
    return origin.protocol === 'https:' && origin.origin === env.APP_ORIGIN && !origin.username && !origin.password
      && USER_ID.test(env.SLACK_OWNER_USER_ID) && TEAM_ID.test(env.SLACK_OWNER_TEAM_ID)
      && /^A[A-Z0-9]{6,20}$/.test(env.SLACK_APP_ID) && /^[0-9]+\.[0-9]+$/.test(env.SLACK_CLIENT_ID)
      && !!env.SLACK_CLIENT_SECRET && !!env.SLACK_SIGNING_SECRET && secret.length === 32 && !!env.ARC_STORE;
  } catch { return false; }
}
async function key(env) {
  let raw;
  try { raw = Uint8Array.from(atob(env.ARC_SECRET_BASE64), c => c.charCodeAt(0)); } catch { throw new ArcError('setup_required', 503); }
  if (raw.length !== 32) throw new ArcError('setup_required', 503);
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(value, env, purpose) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
    additionalData: encoder.encode('arc:v1:' + purpose + ':' + env.APP_ORIGIN), tagLength: 128 }, await key(env), encoder.encode(JSON.stringify(value))));
  return b64url(iv) + '.' + b64url(cipher);
}
export async function open(value, env, purpose) {
  try {
    if (typeof value !== 'string' || value.length > 12000) throw new Error();
    const parts = value.split('.'); if (parts.length !== 2) throw new Error();
    const iv = decode64(parts[0]); if (iv.length !== 12) throw new Error();
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv,
      additionalData: encoder.encode('arc:v1:' + purpose + ':' + env.APP_ORIGIN), tagLength: 128 }, await key(env), decode64(parts[1]));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { throw new ArcError('invalid_session', 401); }
}
export function cookie(name, value, seconds) { return name + '=' + value + '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=' + seconds; }
export function readCookie(request, name) {
  const values = (request.headers.get('Cookie') || '').split(';').map(s => s.trim()).filter(s => s.startsWith(name + '='));
  return values.length === 1 ? values[0].slice(name.length + 1) : null;
}
export async function session(request, env) {
  const value = await open(readCookie(request, SESSION_COOKIE), env, 'session');
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value.sid || '') || !Number.isFinite(value.exp)
    || value.exp <= Date.now() || value.exp > Date.now() + SESSION_SECONDS * 1000 + 60000
    || value.uid !== env.SLACK_OWNER_USER_ID || value.tid !== env.SLACK_OWNER_TEAM_ID) throw new ArcError('sign_in_required', 401);
  return hash(value.sid);
}
export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length > 256) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0;
}
export async function boundedBody(request, maxBytes = 4096, timeoutMs = 8000) {
  const length = request.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new ArcError('body_too_large', 413);
  const reader = request.body?.getReader(); if (!reader) return '';
  const chunks = []; let total = 0;
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
    reject(new ArcError('body_timeout', 408)); reader.cancel().catch(() => {});
  }, timeoutMs); });
  try { while (true) {
    const item = await Promise.race([reader.read(), timeout]); if (item.done) break;
    total += item.value.byteLength; if (total > maxBytes) { reader.cancel().catch(() => {}); throw new ArcError('body_too_large', 413); }
    chunks.push(item.value);
  } } finally { clearTimeout(timer); }
  const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
export async function sameOriginJson(request, env) {
  if (request.method !== 'POST' || request.headers.get('Origin') !== env.APP_ORIGIN
    || (request.headers.get('Sec-Fetch-Site') && request.headers.get('Sec-Fetch-Site') !== 'same-origin')) throw new ArcError('origin_rejected', 403);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) throw new ArcError('json_required', 415);
  try { const data = JSON.parse(await boundedBody(request)); if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error(); return data; }
  catch (error) { if (error instanceof ArcError) throw error; throw new ArcError('invalid_body'); }
}
export async function verifiedSlackBody(request, env, nowSeconds = Math.floor(Date.now() / 1000)) {
  const stamp = request.headers.get('x-slack-request-timestamp') || '';
  const signature = request.headers.get('x-slack-signature') || '';
  if (!/^\d{10}$/.test(stamp) || Math.abs(nowSeconds - Number(stamp)) > 300 || !/^v0=[a-f0-9]{64}$/.test(signature)) throw new ArcError('signature_rejected', 401);
  const raw = await boundedBody(request, 128000, 5000);
  const secret = await crypto.subtle.importKey('raw', encoder.encode(env.SLACK_SIGNING_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', secret, encoder.encode('v0:' + stamp + ':' + raw)));
  const expected = 'v0=' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  if (!equal(signature, expected)) throw new ArcError('signature_rejected', 401);
  try { return JSON.parse(raw); } catch { throw new ArcError('invalid_body'); }
}
export async function slackApi(method, token, args = {}, fetcher = fetch) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetcher('https://slack.com/api/' + method, { method: 'POST',
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(Object.entries(args).map(([k, v]) => [k, String(v)])), signal: controller.signal, redirect: 'error' });
    if (response.status === 429) throw new ArcError('slack_rate_limited', 429, Math.max(1, Number(response.headers.get('Retry-After')) || 60));
    if (!response.ok) throw new ArcError('slack_unavailable', 502);
    const data = JSON.parse(await boundedBody(response, 256000));
    if (data?.ok !== true) {
      const revoked = ['invalid_auth', 'token_revoked', 'token_expired', 'account_inactive', 'not_authed'].includes(data?.error);
      throw new ArcError(revoked ? 'slack_revoked' : 'slack_request_failed', revoked ? 401 : 502);
    }
    return data;
  } catch (error) { if (error instanceof ArcError) throw error; throw new ArcError('slack_unavailable', 502); }
  finally { clearTimeout(timer); }
}
export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store, max-age=0', 'Pragma': 'no-cache', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Vary': 'Cookie', ...extra } });
}
