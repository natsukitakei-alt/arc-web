import { CHANNEL_ID, USER_ID, TS, hash } from './security.mjs';
import { extractTasks } from './tasks.mjs';
export const DAY = 86400000;
export const MAX_MESSAGES = 160;
export function emptyEvidence() { return { records: [], tombstones: [], seen: [], overrides: {}, lastEventAt: null, importedAt: null }; }
export function prune(evidence, now = Date.now()) {
  evidence.records = evidence.records.filter(m => Number(m.ts) * 1000 >= now - 7 * DAY).sort((a, b) => Number(b.ts) - Number(a.ts)).slice(0, MAX_MESSAGES);
  let bytes = 0; const encoder = new TextEncoder();
  evidence.records = evidence.records.filter(record => {
    const size = encoder.encode(JSON.stringify(record)).byteLength;
    if (bytes + size > 50000) return false; bytes += size; return true;
  });
  evidence.tombstones = evidence.tombstones.filter(t => t.until > now).slice(-MAX_MESSAGES);
  evidence.seen = evidence.seen.filter(e => e.until > now).slice(-200);
  const tasks = taskList(evidence, now); const valid = new Set(tasks.map(t => t.id));
  for (const id of Object.keys(evidence.overrides)) if (!valid.has(id)) delete evidence.overrides[id];
  return evidence;
}
export function taskList(evidence, now = Date.now()) { return extractTasks(evidence.records, evidence.owner, new Date(now), 40); }
export async function publicTasks(evidence, now = Date.now()) {
  return Promise.all(taskList(evidence, now).map(async t => {
    const override = evidence.overrides[t.id];
    const matches = override?.fingerprint === await fingerprint(t);
    return { ...t, status: matches ? override.status : t.status, manuallyChanged: matches, needsReview: true };
  }));
}
export function fingerprint(task) { return hash(JSON.stringify([task.title, task.detail, task.status, task.deadline, task.sourceUrl])); }
function sourceUrl(host, channel, ts, threadTs) {
  const path = '/archives/' + channel + '/p' + ts.split('.')[0] + ts.split('.')[1].padEnd(6, '0');
  const url = new URL(path, 'https://' + host);
  if (threadTs && threadTs !== ts) { url.searchParams.set('thread_ts', threadTs); url.searchParams.set('cid', channel); }
  return url.href;
}
export function trustedMessage(raw, channel, channelType, host, now = Date.now()) {
  if (!CHANNEL_ID.test(channel) || !USER_ID.test(raw?.user || '') || !TS.test(raw?.ts || '')
    || typeof raw.text !== 'string' || raw.text.includes('\0') || raw.text.length > 16000
    || Number(raw.ts) * 1000 < now - 7 * DAY || Number(raw.ts) * 1000 > now + 60000
    || !/^[a-z0-9][a-z0-9-]*\.slack\.com$/.test(host || '')) return null;
  const threadTs = TS.test(raw.thread_ts || '') && Number(raw.thread_ts) <= Number(raw.ts) ? raw.thread_ts : null;
  return { channelId: channel, channelType, channelName: channelType === 'im' ? 'DM' : channel,
    userId: raw.user, ts: raw.ts, threadTs, text: raw.text.slice(0, 1500), verifiedAuthor: true,
    version: Number(raw.edited?.ts || raw.ts), url: sourceUrl(host, channel, raw.ts, threadTs) };
}
export function ingest(evidence, event, host, now = Date.now()) {
  if (event?.type !== 'message' || !CHANNEL_ID.test(event.channel || '')) return false;
  const raw = event.subtype === 'message_changed' ? event.message : event;
  const ts = event.subtype === 'message_deleted' ? event.deleted_ts : raw?.ts;
  if (!TS.test(ts || '')) return false;
  const key = event.channel + ':' + ts;
  const old = evidence.records.find(m => m.channelId + ':' + m.ts === key);
  const version = Number(event.event_ts || (event.subtype ? event.ts : raw.edited?.ts) || ts);
  if (!Number.isFinite(version) || version * 1000 > now + 60000 || (old && version < old.version)) return false;
  if (event.subtype === 'message_deleted') {
    evidence.records = evidence.records.filter(m => m.channelId + ':' + m.ts !== key);
    evidence.tombstones = evidence.tombstones.filter(t => t.key !== key);
    evidence.tombstones.push({ key, version, until: now + 7 * DAY }); return true;
  }
  if (event.subtype && event.subtype !== 'message_changed' && event.subtype !== 'thread_broadcast') return false;
  if (evidence.tombstones.some(t => t.key === key && t.version >= version)) return false;
  const channelType = ['im', 'mpim', 'group', 'channel'].includes(event.channel_type) ? event.channel_type : old?.channelType;
  const message = trustedMessage(raw, event.channel, channelType, host, now);
  if (!message) return false;
  // A missing channel type never grants DM-recipient assumptions.
  const direct = channelType === 'im';
  const mentioned = message.text.includes('<@' + evidence.owner + '>') || message.text.includes('<@' + evidence.owner + '|');
  const root = message.threadTs || message.ts;
  const tracked = evidence.records.some(m => m.channelId === message.channelId && (m.threadTs || m.ts) === root);
  if (!old && !tracked && !direct && !mentioned) return false;
  if (!channelType && !tracked && !mentioned) return false;
  // Parser uses D prefixes for direct messages; unknown D events cannot seed a task.
  if (message.channelId.startsWith('D') && !direct && !tracked) return false;
  // Store only a task-producing origin, then bounded replies to that origin.
  if (!old && !tracked && !extractTasks([message], evidence.owner, new Date(now), 1).length) return false;
  message.version = version; evidence.records = evidence.records.filter(m => m.channelId + ':' + m.ts !== key);
  evidence.records.push(message); return true;
}
