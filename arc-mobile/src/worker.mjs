import { ArcError, configured, seal, open, cookie, readCookie, session, hash, randomId, equal,
  OAUTH_COOKIE, SESSION_COOKIE, SESSION_SECONDS, SCOPES, sameOriginJson, verifiedSlackBody, slackApi, json } from './security.mjs';
export { ArcOwnerStore } from './store.mjs';

function store(env, path, data) {
  const id = env.ARC_STORE.idFromName(env.SLACK_OWNER_TEAM_ID + ':' + env.SLACK_OWNER_USER_ID);
  return env.ARC_STORE.get(id).fetch(new Request('https://arc.internal' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }));
}
async function result(response) {
  const data = await response.json();
  if (!response.ok) throw new ArcError(data.error || 'server_error', response.status, Number(response.headers.get('Retry-After')) || 0);
  return data;
}
function redirect(env, path, cookies = []) {
  const headers = new Headers({ Location: env.APP_ORIGIN + path, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  for (const value of cookies) headers.append('Set-Cookie', value);
  return new Response(null, { status: 303, headers });
}
export async function route(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/auth/')) return env.ASSETS.fetch(request);
  // URL verification can precede configuration of the OAuth client. It still requires a signing secret.
  if (url.pathname === '/api/slack/events' && request.method === 'POST') {
    if (!env.SLACK_SIGNING_SECRET) throw new ArcError('setup_required', 503);
    const payload = await verifiedSlackBody(request, env);
    if (payload.type === 'url_verification') {
      if (typeof payload.challenge !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(payload.challenge)) throw new ArcError('invalid_body');
      return json({ challenge: payload.challenge });
    }
    if (!configured(env)) throw new ArcError('setup_required', 503);
    if (payload.type !== 'event_callback' || payload.api_app_id !== env.SLACK_APP_ID || payload.team_id !== env.SLACK_OWNER_TEAM_ID
      || !/^Ev[A-Za-z0-9]{6,80}$/.test(payload.event_id || '') || !payload.event) return json({ ok: true });
    const type = payload.event.type;
    const revoked = type === 'tokens_revoked' && Array.isArray(payload.event.tokens?.oauth) && payload.event.tokens.oauth.includes(env.SLACK_OWNER_USER_ID);
    const uninstall = type === 'app_uninstalled';
    const authorized = payload.authorizations?.some(a => a?.is_bot === false && a.user_id === env.SLACK_OWNER_USER_ID && a.team_id === env.SLACK_OWNER_TEAM_ID);
    if (!uninstall && !revoked && !(type === 'message' && authorized)) return json({ ok: true });
    // DO ingress does no Slack HTTP calls. ACK only after the bounded evidence write succeeds.
    return store(env, '/event', { payload });
  }
  if (!configured(env)) throw new ArcError('setup_required', 503);
  if (url.origin !== env.APP_ORIGIN) throw new ArcError('origin_rejected', 403);
  if (url.pathname === '/auth/slack' && request.method === 'GET') {
    const nonce = randomId(); const exp = Date.now() + 10 * 60000;
    await result(await store(env, '/oauth-state', { hash: await hash(nonce) }));
    const state = await seal({ nonce, exp }, env, 'oauth');
    const target = new URL('https://slack.com/oauth/v2/authorize');
    target.search = new URLSearchParams({ client_id: env.SLACK_CLIENT_ID, user_scope: SCOPES,
      redirect_uri: env.APP_ORIGIN + '/auth/slack/callback', state: nonce, team: env.SLACK_OWNER_TEAM_ID }).toString();
    return new Response(null, { status: 303, headers: { Location: target.href,
      'Set-Cookie': cookie(OAUTH_COOKIE, state, 600), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  }
  if (url.pathname === '/auth/slack/callback' && request.method === 'GET') {
    const clear = cookie(OAUTH_COOKIE, '', 0);
    try {
      const pending = await open(readCookie(request, OAUTH_COOKIE), env, 'oauth');
      if (!pending || pending.exp <= Date.now() || pending.exp > Date.now() + 600000 || !equal(pending.nonce, url.searchParams.get('state'))) throw new ArcError('oauth_expired', 401);
      const { generation } = await result(await store(env, '/oauth-state', { hash: await hash(pending.nonce), consume: true }));
      const code = url.searchParams.get('code');
      if (url.searchParams.has('error') || !code || code.length > 1000 || url.searchParams.getAll('code').length !== 1) throw new ArcError('oauth_cancelled');
      const oauth = await slackApi('oauth.v2.access', '', { client_id: env.SLACK_CLIENT_ID, client_secret: env.SLACK_CLIENT_SECRET,
        code, redirect_uri: env.APP_ORIGIN + '/auth/slack/callback' });
      const user = oauth.authed_user;
      if (oauth.app_id !== env.SLACK_APP_ID || oauth.team?.id !== env.SLACK_OWNER_TEAM_ID || user?.id !== env.SLACK_OWNER_USER_ID || user.token_type !== 'user'
        || typeof user.access_token !== 'string' || user.access_token.length > 2000) throw new ArcError('owner_only', 403);
      if (!SCOPES.split(',').every(scope => String(user.scope || '').split(',').includes(scope))) throw new ArcError('slack_request_failed', 502);
      const identity = await slackApi('auth.test', user.access_token);
      if (identity.team_id !== env.SLACK_OWNER_TEAM_ID || identity.user_id !== env.SLACK_OWNER_USER_ID || identity.bot_id) throw new ArcError('owner_only', 403);
      const slackUrl = new URL(identity.url);
      if (slackUrl.protocol !== 'https:' || slackUrl.username || slackUrl.password || slackUrl.port
        || !/^[a-z0-9][a-z0-9-]*\.slack\.com$/.test(slackUrl.hostname)) throw new ArcError('slack_request_failed', 502);
      const sid = randomId(); const credentials = await seal({ access: user.access_token, refresh: user.refresh_token || null,
        expiresAt: user.expires_in > 0 ? Date.now() + user.expires_in * 1000 : null }, env, 'slack-token');
      await result(await store(env, '/install', { credentials, host: slackUrl.hostname, hash: await hash(sid), generation }));
      const value = await seal({ sid, uid: env.SLACK_OWNER_USER_ID, tid: env.SLACK_OWNER_TEAM_ID, exp: Date.now() + SESSION_SECONDS * 1000 }, env, 'session');
      return redirect(env, '/', [clear, cookie(SESSION_COOKIE, value, SESSION_SECONDS)]);
    } catch (error) {
      const code = error instanceof ArcError ? error.code : 'slack_unavailable';
      return redirect(env, '/?connection=' + encodeURIComponent(code), [clear]);
    }
  }
  if (url.pathname === '/api/status' && request.method === 'GET') {
    try { return await store(env, '/status', { hash: await session(request, env) }); }
    catch (error) { if (error.status === 401) return json({ connected: false }); throw error; }
  }
  if (url.pathname === '/api/tasks' && request.method === 'GET') return store(env, '/tasks', { hash: await session(request, env) });
  const paths = { '/api/conversations': '/conversations', '/api/backfill': '/backfill', '/api/task-status': '/task-status',
    '/api/logout': '/logout', '/api/disconnect': '/disconnect', '/api/clear': '/clear' };
  if (paths[url.pathname]) {
    const body = await sameOriginJson(request, env); const sessionHash = await session(request, env);
    const allowed = url.pathname === '/api/backfill' ? ['channels'] : url.pathname === '/api/task-status' ? ['id', 'status'] : [];
    if (Object.keys(body).some(k => !allowed.includes(k))) throw new ArcError('invalid_body');
    const upstream = await store(env, paths[url.pathname], { ...body, hash: sessionHash });
    const response = new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    if (url.pathname === '/api/logout' || url.pathname === '/api/disconnect') response.headers.append('Set-Cookie', cookie(SESSION_COOKIE, '', 0));
    return response;
  }
  throw new ArcError('not_found', 404);
}
export default {
  async fetch(request, env) {
    try { return await route(request, env); }
    catch (error) { return json({ error: error instanceof ArcError ? error.code : 'server_error' }, error instanceof ArcError ? error.status : 500,
      error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {}); }
  }
};
