import { ArcError, open, seal, slackApi, json, randomId, CHANNEL_ID, SESSION_SECONDS } from './security.mjs';
import { emptyEvidence, prune, ingest, publicTasks, fingerprint, taskList, DAY } from './evidence.mjs';

export class ArcOwnerStore {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.refreshing = null; this.backfilling = false;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.data = await ctx.storage.get('owner') || { generation: 1, active: false, sessions: {}, states: {}, cooldowns: {}, evidence: emptyEvidence() };
      this.data.evidence.owner = env.SLACK_OWNER_USER_ID;
    });
  }
  async persist() {
    prune(this.data.evidence);
    const encoder = new TextEncoder(); let size = encoder.encode(JSON.stringify(this.data)).byteLength;
    // SQLite KV compatibility methods cap one value at 128 KiB. Keep this owner row below that cap.
    while (size > 120000 && this.data.evidence.records.length) {
      const removed = this.data.evidence.records.pop(); size -= encoder.encode(JSON.stringify(removed)).byteLength + 1;
    }
    if (encoder.encode(JSON.stringify(this.data)).byteLength > 120000) throw new ArcError('storage_limit', 503);
    await this.ctx.storage.put('owner', this.data);
    // Alarms enforce message retention even when the phone is closed.
    const expiry = this.data.evidence.records.map(m => Number(m.ts) * 1000 + 7 * DAY);
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, Math.min(Date.now() + DAY, ...expiry)));
  }
  async alarm() {
    await this.ready; prune(this.data.evidence);
    this.data.states = Object.fromEntries(Object.entries(this.data.states).filter(([, s]) => s.exp > Date.now()));
    this.data.sessions = Object.fromEntries(Object.entries(this.data.sessions).filter(([, s]) => s.exp > Date.now()));
    if (this.data.active || Object.keys(this.data.states).length) await this.persist();
    else { await this.ctx.storage.put('owner', this.data); await this.ctx.storage.deleteAlarm(); }
  }
  async purge() {
    this.data = { generation: this.data.generation + 1, evidenceEpoch: (this.data.evidenceEpoch || 0) + 1,
      controlSeen: this.data.controlSeen || [], active: false, sessions: {}, states: {}, cooldowns: {}, evidence: emptyEvidence() };
    this.data.evidence.owner = this.env.SLACK_OWNER_USER_ID;
    await this.ctx.storage.put('owner', this.data); await this.ctx.storage.deleteAlarm();
  }
  check(hash) {
    const session = this.data.sessions[hash];
    if (!this.data.active || this.data.uid !== this.env.SLACK_OWNER_USER_ID || this.data.tid !== this.env.SLACK_OWNER_TEAM_ID
      || this.data.appId !== this.env.SLACK_APP_ID
      || !session || session.exp <= Date.now() || session.generation !== this.data.generation) throw new ArcError('sign_in_required', 401);
    return this.data.generation;
  }
  guard(generation) { if (!this.data.active || generation !== this.data.generation) throw new ArcError('sign_in_required', 401); }
  async call(method, args, generation) {
    this.guard(generation);
    const until = this.data.cooldowns[method] || 0;
    if (until > Date.now()) throw new ArcError('slack_rate_limited', 429, Math.ceil((until - Date.now()) / 1000));
    try { const credentials = await this.credentials(generation); const result = await slackApi(method, credentials.access, args);
      this.guard(generation); return result;
    } catch (error) {
      if (generation === this.data.generation && error.code === 'slack_revoked') await this.purge();
      if (generation === this.data.generation && error.retryAfter) { this.data.cooldowns[method] = Date.now() + error.retryAfter * 1000; await this.persist(); }
      throw error;
    }
  }
  async credentials(generation) {
    this.guard(generation);
    const current = await open(this.data.credentials, this.env, 'slack-token'); this.guard(generation);
    if (!current.expiresAt || current.expiresAt > Date.now() + 300000) return current;
    if (!current.refresh) { await this.purge(); throw new ArcError('sign_in_required', 401); }
    if (!this.refreshing) {
      const work = (async () => {
        this.guard(generation);
        const next = await slackApi('oauth.v2.access', '', { grant_type: 'refresh_token', refresh_token: current.refresh,
          client_id: this.env.SLACK_CLIENT_ID, client_secret: this.env.SLACK_CLIENT_SECRET });
        this.guard(generation);
        if ((next.app_id && next.app_id !== this.env.SLACK_APP_ID) || (next.team?.id && next.team.id !== this.env.SLACK_OWNER_TEAM_ID)
          || next.token_type !== 'user' || !next.access_token || !next.refresh_token || !(next.expires_in > 0)) throw new ArcError('sign_in_required', 401);
        const token = { access: next.access_token, refresh: next.refresh_token, expiresAt: Date.now() + next.expires_in * 1000 };
        const encrypted = await seal(token, this.env, 'slack-token'); this.guard(generation);
        this.data.credentials = encrypted; await this.persist(); return token;
      })();
      this.refreshing = work;
      work.finally(() => { if (this.refreshing === work) this.refreshing = null; }).catch(() => {});
    }
    try { const token = await this.refreshing; this.guard(generation); return token; }
    catch (error) { if (generation === this.data.generation && error.status !== 429) await this.purge(); throw error; }
  }
  async liveAuth(generation) {
    if ((this.data.checkedAt || 0) > Date.now() - 15 * 60000) return;
    const result = await this.call('auth.test', {}, generation);
    if (result.user_id !== this.env.SLACK_OWNER_USER_ID || result.team_id !== this.env.SLACK_OWNER_TEAM_ID || result.bot_id) {
      await this.purge(); throw new ArcError('sign_in_required', 401);
    }
    this.guard(generation); this.data.checkedAt = Date.now(); await this.persist();
  }
  async fetch(request) {
    await this.ready;
    try { return await this.route(new URL(request.url).pathname, await request.json()); }
    catch (error) { return json({ error: error instanceof ArcError ? error.code : 'server_error' }, error instanceof ArcError ? error.status : 500,
      error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {}); }
  }
  async route(path, input) {
    if (path === '/oauth-state') {
      const now = Date.now();
      this.data.states = Object.fromEntries(Object.entries(this.data.states).filter(([, s]) => s.exp > now).slice(-30));
      if (input.consume) {
        const state = this.data.states[input.hash]; delete this.data.states[input.hash]; await this.persist();
        if (!state || state.exp <= now || state.generation !== this.data.generation) throw new ArcError('oauth_expired', 401);
        return json({ generation: state.generation });
      }
      this.data.states[input.hash] = { exp: now + 10 * 60000, generation: this.data.generation }; await this.persist(); return json({ ok: true });
    }
    if (path === '/install') {
      if (input.generation !== this.data.generation) throw new ArcError('oauth_expired', 401);
      this.data.generation++; this.data.states = {}; this.data.sessions = {}; this.refreshing = null;
      this.data.active = true; this.data.uid = this.env.SLACK_OWNER_USER_ID; this.data.tid = this.env.SLACK_OWNER_TEAM_ID;
      this.data.appId = this.env.SLACK_APP_ID;
      this.data.credentials = input.credentials; this.data.host = input.host; this.data.checkedAt = Date.now();
      this.data.sessions = Object.fromEntries(Object.entries(this.data.sessions).filter(([, s]) => s.exp > Date.now()).slice(-19));
      this.data.sessions[input.hash] = { exp: Date.now() + SESSION_SECONDS * 1000, generation: this.data.generation };
      this.data.connectedAt = new Date().toISOString(); this.data.installedAt = Math.floor(Date.now() / 1000);
      await this.persist(); return json({ ok: true });
    }
    if (path === '/event') {
      const payload = input.payload;
      if (payload.event.type === 'app_uninstalled' || payload.event.type === 'tokens_revoked') {
        this.data.controlSeen = (this.data.controlSeen || []).filter(e => e.until > Date.now()).slice(-31);
        if (this.data.controlSeen.some(e => e.id === payload.event_id)) return json({ ok: true });
        this.data.controlSeen.push({ id: payload.event_id, until: Date.now() + DAY });
        if (this.data.active && Number.isSafeInteger(payload.event_time) && payload.event_time < this.data.installedAt) {
          await this.persist(); return json({ ok: true });
        }
        await this.purge(); return json({ ok: true });
      }
      if (!this.data.active || this.data.appId !== this.env.SLACK_APP_ID) return json({ ok: true });
      prune(this.data.evidence);
      if (this.data.evidence.seen.some(e => e.id === payload.event_id)) return json({ ok: true });
      this.data.evidence.seen.push({ id: payload.event_id, until: Date.now() + DAY });
      ingest(this.data.evidence, payload.event, this.data.host);
      this.data.evidence.lastEventAt = new Date().toISOString(); prune(this.data.evidence); await this.persist(); return json({ ok: true });
    }
    const generation = this.check(input.hash);
    if (path === '/logout') { delete this.data.sessions[input.hash]; await this.persist(); return json({ ok: true }); }
    if (path === '/disconnect') {
      let revoked = false;
      try { const token = await this.credentials(generation); const result = await slackApi('auth.revoke', token.access); revoked = result.revoked === true; } catch {}
      this.guard(generation); await this.purge(); return json({ ok: true, revoked });
    }
    if (path === '/clear') { this.data.evidenceEpoch = (this.data.evidenceEpoch || 0) + 1;
      this.data.evidence = emptyEvidence(); this.data.evidence.owner = this.env.SLACK_OWNER_USER_ID; await this.persist(); return json({ ok: true }); }
    if (path === '/status') return json({ connected: true, connectedAt: this.data.connectedAt });
    await this.liveAuth(generation); this.guard(generation);
    if (path === '/tasks') {
      prune(this.data.evidence); await this.persist();
      const tasks = await publicTasks(this.data.evidence); this.guard(generation);
      return json({ tasks, lastEventAt: this.data.evidence.lastEventAt,
        importedAt: this.data.evidence.importedAt, connectedAt: this.data.connectedAt,
        coverage: '接続後に届いたメンション・DMと、取り込んだ会話の直近7日が対象です。候補は必ず原文で確認してください。' });
    }
    if (path === '/task-status') {
      const task = taskList(this.data.evidence).find(t => t.id === input.id);
      if (!task || !['todo', 'waiting', 'done'].includes(input.status)) throw new ArcError('invalid_task');
      const version = await fingerprint(task); this.guard(generation);
      this.data.evidence.overrides[input.id] = { status: input.status, fingerprint: version }; await this.persist(); return json({ ok: true });
    }
    if (path === '/conversations') {
      const result = await this.call('users.conversations', { types: 'public_channel,private_channel,im,mpim', exclude_archived: true, limit: 50 }, generation);
      this.data.allowedChannels = (result.channels || []).filter(c => CHANNEL_ID.test(c.id) && !c.is_archived).slice(0, 50).map(c => ({
        id: c.id, name: c.is_im ? 'DM (' + c.id + ')' : String(c.name || c.id).slice(0, 80),
        type: c.is_im ? 'im' : c.is_mpim ? 'mpim' : c.is_private ? 'group' : 'channel' }));
      await this.persist(); return json({ channels: this.data.allowedChannels, partial: !!result.response_metadata?.next_cursor });
    }
    if (path === '/backfill') {
      if (this.backfilling) throw new ArcError('sync_busy', 409);
      if (!Array.isArray(input.channels) || !input.channels.length || input.channels.length > 3
        || new Set(input.channels).size !== input.channels.length || input.channels.some(id => !this.data.allowedChannels?.some(c => c.id === id))) throw new ArcError('invalid_channel');
      const until = this.data.backfillAfter || 0;
      if (until > Date.now()) throw new ArcError('slack_rate_limited', 429, Math.ceil((until - Date.now()) / 1000));
      this.backfilling = true; this.data.backfillAfter = Date.now() + 60000;
      const epoch = this.data.evidenceEpoch || 0;
      const selection = input.channels.map(id => ({ ...this.data.allowedChannels.find(c => c.id === id) }));
      const checkEvidence = () => { this.guard(generation); if (epoch !== (this.data.evidenceEpoch || 0)) throw new ArcError('data_changed', 409); };
      let count = 0; let partial = false; const threads = []; const deadline = Date.now() + 28000;
      try {
        for (const channel of selection) {
          checkEvidence(); const id = channel.id;
          if (Date.now() > deadline) { partial = true; break; }
          const result = await this.call('conversations.history', { channel: id, oldest: (Date.now() - 7 * DAY) / 1000, limit: 15 }, generation);
          checkEvidence();
          partial ||= !!result.has_more || !!result.response_metadata?.next_cursor;
          for (const m of (result.messages || []).slice(0, 15).reverse()) {
            if (ingest(this.data.evidence, { ...m, type: 'message', channel: id, channel_type: channel.type }, this.data.host)) {
              count++; if (m.reply_count > 0 && (!m.thread_ts || m.thread_ts === m.ts)) threads.push({ id, ts: m.ts, type: channel.type });
            }
          }
        }
        for (const thread of threads.slice(0, 1)) {
          if (Date.now() > deadline) { partial = true; break; }
          const result = await this.call('conversations.replies', { channel: thread.id, ts: thread.ts, limit: 15 }, generation);
          checkEvidence();
          partial ||= !!result.has_more || !!result.response_metadata?.next_cursor;
          for (const m of (result.messages || []).slice(0, 15)) if (ingest(this.data.evidence, { ...m, type: 'message', channel: thread.id, channel_type: thread.type }, this.data.host)) count++;
        }
        partial ||= threads.length > 1;
        checkEvidence(); prune(this.data.evidence); this.data.evidence.importedAt = new Date().toISOString(); await this.persist();
        return json({ ok: true, count, partial });
      } finally { this.backfilling = false; }
    }
    throw new ArcError('not_found', 404);
  }
}
