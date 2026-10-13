'use strict';
const byId = id => document.getElementById(id);
const labels = { todo: '対応する', waiting: '返答待ち', done: '完了' };
const errors = {
  setup_required: '接続設定を準備中です。CloudflareとSlackの設定後に利用できます。',
  sign_in_required: 'Slackに接続してください。', invalid_session: 'ログインの期限が切れました。もう一度接続してください。',
  owner_only: 'このARCは本人専用です。指定したSlackアカウントで接続してください。',
  oauth_expired: '接続操作の期限が切れました。もう一度接続してください。', oauth_cancelled: 'Slackの接続は完了していません。',
  slack_revoked: 'Slackの認証が無効になりました。再接続してください。',
  slack_rate_limited: 'Slackの取得制限に達しました。しばらく待って更新してください。',
  slack_unavailable: 'Slackに接続できませんでした。しばらく待って更新してください。',
  slack_request_failed: 'Slackの読み取りに失敗しました。アプリの権限を確認してください。',
  sync_busy: '履歴を取り込んでいます。完了までお待ちください。',
  data_changed: '保存状態が変わったため、取り込みを中止しました。',
  invalid_channel: '会話を1〜3つ選んでください。'
};
let tasks = [], filter = 'todo', connected = false, timer, controller, generation = 0, retryAt = 0;
let actionEpoch = 0; const actionControllers = new Set();
function notice(text, error = false) { byId('notice').textContent = text; byId('notice').classList.toggle('error', error); }
function stopActions() { actionEpoch++; for (const active of actionControllers) active.abort(); actionControllers.clear(); }
function wipe() {
  tasks = []; byId('tasks').replaceChildren(); byId('channels').replaceChildren(); byId('import').hidden = true;
  for (const status of Object.keys(labels)) byId(status + '-count').textContent = '0';
  byId('updated').textContent = '未取得'; byId('coverage').textContent = '';
  for (const id of ['list-channels', 'import', 'clear', 'logout', 'disconnect']) byId(id).disabled = false;
}
function disconnected() { connected = false; stopActions(); wipe(); byId('dashboard').hidden = true; byId('connect').hidden = false; }
function timeLabel(date) { return date ? new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(date)) : 'まだ届いていません'; }
async function api(path, body, signal) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(errors[data.error] || '取得できませんでした。もう一度お試しください。'); error.status = response.status; error.code = data.error;
    if (response.status === 429) retryAt = Date.now() + Math.max(1, Number(response.headers.get('Retry-After')) || 60) * 1000;
    throw error;
  }
  return data;
}
async function action(button, run) {
  if (!connected || document.hidden) return;
  const epoch = actionEpoch, active = new AbortController(); actionControllers.add(active); button.disabled = true;
  const current = () => epoch === actionEpoch && connected && !document.hidden && !active.signal.aborted;
  try { await run((path, body) => api(path, body, active.signal), current); }
  catch (error) { if (current() && error.name !== 'AbortError') { if ([401, 403].includes(error.status)) disconnected(); notice(error.message, true); } }
  finally { actionControllers.delete(active); if (epoch === actionEpoch) button.disabled = false; }
}
function node(tag, text, className) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; }
function draw() {
  for (const status of Object.keys(labels)) byId(status + '-count').textContent = tasks.filter(t => t.status === status).length;
  const shown = tasks.filter(t => filter === 'all' || t.status === filter); const container = byId('tasks'); container.replaceChildren();
  if (!shown.length) { container.append(node('div', 'この表示のタスク候補はありません。接続前の依頼は履歴から取り込めます。', 'empty')); return; }
  for (const task of shown) {
    const card = node('article', undefined, 'task'); const meta = node('div', undefined, 'task-meta');
    meta.append(node('span', task.channelName), node('span', task.manuallyChanged ? '手動で整理' : '要確認')); card.append(meta, node('h3', task.title));
    card.append(node('span', task.deadlineLabel, 'due'));
    const detail = node('details'); detail.append(node('summary', '依頼の原文'), node('pre', task.detail)); card.append(detail);
    const bottom = node('div', undefined, 'task-bottom');
    const link = node('a', 'Slackで確認 ↗');
    try { const url = new URL(task.sourceUrl); if (url.protocol === 'https:' && /^[a-z0-9][a-z0-9-]*\.slack\.com$/.test(url.hostname)) { link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; bottom.append(link); } } catch {}
    const select = node('select'); select.setAttribute('aria-label', task.title + 'の状態');
    for (const [value, label] of Object.entries(labels)) { const option = node('option', label); option.value = value; option.selected = value === task.status; select.append(option); }
    select.addEventListener('change', async () => {
      await action(select, async (call, current) => {
        await call('/api/task-status', { id: task.id, status: select.value }); if (!current()) return;
        await refresh(true); if (current()) notice('一覧の状態を変更しました。Slackへの投稿は行いません。');
      }); select.value = task.status;
    }); bottom.append(select); card.append(bottom); container.append(card);
  }
}
function schedule() { clearTimeout(timer); if (connected && !document.hidden) timer = setTimeout(() => refresh(false), Math.max(60000, retryAt - Date.now())); }
async function refresh(manual) {
  if (document.hidden || !connected) return;
  if (Date.now() < retryAt) { if (manual) notice('取得制限の解除までお待ちください。', true); schedule(); return; }
  controller?.abort(); const version = ++generation; controller = new AbortController(); byId('refresh').disabled = true;
  try {
    const data = await api('/api/tasks', undefined, controller.signal);
    if (version !== generation || document.hidden || controller.signal.aborted) return;
    tasks = data.tasks; draw(); byId('coverage').textContent = data.coverage;
    byId('updated').textContent = 'Slack受信 ' + timeLabel(data.lastEventAt);
    notice('接続中 · Slackの更新を自動で反映します。');
  } catch (error) {
    if (version !== generation || error.name === 'AbortError' || document.hidden) return;
    if ([401, 403].includes(error.status)) { disconnected(); notice(error.message, true); }
    else notice(error.message + ' 表示中の一覧は前回の取得内容です。', true);
  } finally { if (version === generation) { byId('refresh').disabled = false; schedule(); } }
}
async function start() {
  if (document.hidden) return; controller?.abort(); const version = ++generation; controller = new AbortController();
  try {
    const data = await api('/api/status', undefined, controller.signal);
    if (version !== generation || document.hidden) return;
    if (!data.connected) { disconnected(); notice(connection ? errors[connection] || '接続をやり直してください。' : 'Slackに接続すると、ここにタスク候補が表示されます。', !!connection); return; }
    connected = true; byId('connect').hidden = true; byId('dashboard').hidden = false; await refresh(false);
  } catch (error) { if (error.name === 'AbortError' || version !== generation || document.hidden) return; disconnected(); notice(error.message, true); }
}
for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => {
  filter = button.dataset.filter; for (const item of document.querySelectorAll('[data-filter]')) { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); } draw();
});
byId('refresh').addEventListener('click', () => refresh(true));
byId('list-channels').addEventListener('click', async () => {
  await action(byId('list-channels'), async (call, current) => {
    const data = await call('/api/conversations', {}); if (!current()) return;
    byId('channels').replaceChildren();
    for (const channel of data.channels) { const label = node('label', undefined, 'channel'); const input = node('input'); input.type = 'checkbox'; input.value = channel.id; label.append(input, node('span', channel.name)); byId('channels').append(label); }
    byId('import').hidden = !data.channels.length;
    notice(data.partial ? '会話の先頭50件を表示しています。' : '取り込む会話を1〜3つ選んでください。');
  });
});
byId('import').addEventListener('click', async () => {
  const channels = [...byId('channels').querySelectorAll('input:checked')].map(i => i.value);
  if (channels.length < 1 || channels.length > 3) { notice(errors.invalid_channel, true); return; }
  notice('最近の依頼と返信を取り込んでいます…');
  await action(byId('import'), async (call, current) => {
    const data = await call('/api/backfill', { channels }); if (!current()) return; await refresh(true);
    if (current()) notice(data.partial ? '履歴の一部を取り込みました。表示されない依頼はSlackでも確認してください。' : '選んだ会話の最近の履歴を取り込みました。');
  });
});
for (const [id, text] of [['clear', '保存している依頼とタスクを消去しますか？ 新しいSlackの更新は引き続き取り込みます。'],
  ['logout', 'この端末をログアウトしますか？'], ['disconnect', 'Slackの接続を解除しますか？ 保存データと全端末のログインを消去します。']]) {
  byId(id).addEventListener('click', async () => {
    if (!window.confirm(text)) return;
    await action(byId(id), async (call, current) => {
      const data = await call('/api/' + id, {}); if (!current()) return;
      ++generation; controller?.abort(); clearTimeout(timer); stopActions(); wipe();
      if (id === 'clear') { const completedEpoch = actionEpoch; await refresh(true);
        if (completedEpoch === actionEpoch && connected && !document.hidden) notice('保存タスクを消去しました。'); }
      else { disconnected(); notice(id === 'disconnect' && !data.revoked ? 'ARCの接続と保存データを削除しました。Slack側のアプリ解除も確認してください。' : '接続を終了しました。'); }
    });
  });
}
function pause() { clearTimeout(timer); ++generation; controller?.abort(); stopActions(); wipe(); }
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); else start(); });
window.addEventListener('pagehide', pause);
window.addEventListener('pageshow', () => start());
if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) byId('install-help').hidden = true;
const connection = new URL(location.href).searchParams.get('connection');
if (connection) { history.replaceState(null, '', '/'); notice(errors[connection] || '接続をやり直してください。', true); }
else start();
