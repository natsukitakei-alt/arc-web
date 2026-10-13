// Independent local UI review of this new app. Fictional data only; no Slack or Cloudflare credentials.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../public/', import.meta.url));
const tasks = [
  { id: 'CFAKE001:fake1', title: '本日15時までに企画資料を確認してください。', detail: '架空データ：本日15時までに企画資料を確認してください。', status: 'todo', channelName: '#企画（架空）', deadlineLabel: '今日 15:00（日本時間）', sourceUrl: 'https://example.slack.com/archives/CFAKE001/p1000000000000000' },
  { id: 'CFAKE001:fake2', title: '見積書を送付してください。', detail: '架空データ：見積書を送付してください。', status: 'todo', channelName: 'DM（架空）', deadlineLabel: '期限の指定なし', sourceUrl: 'https://example.slack.com/archives/CFAKE001/p1000000000000001' },
  { id: 'CFAKE001:fake3', title: '担当者へ確認をお願いできますか。', detail: '架空データ：担当者へ確認をお願いできますか。', status: 'waiting', channelName: '#進行（架空）', deadlineLabel: '期限の指定なし', sourceUrl: 'https://example.slack.com/archives/CFAKE001/p1000000000000002' }
];
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1:8789');
    response.setHeader('Cache-Control', 'no-store');
    if (url.pathname.startsWith('/api/')) {
      response.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/api/status') response.end(JSON.stringify({ connected: true }));
      else if (url.pathname === '/api/tasks') response.end(JSON.stringify({ tasks, lastEventAt: new Date().toISOString(), coverage: '画面確認用の架空データです。実際のSlackには接続していません。' }));
      else if (url.pathname === '/api/conversations') response.end(JSON.stringify({ channels: [{ id: 'CFAKE001', name: '#架空の会話' }] }));
      else { response.statusCode = 403; response.end(JSON.stringify({ error: 'preview_only' })); }
      return;
    }
    const target = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!target.startsWith(root + path.sep)) { response.statusCode = 404; response.end(); return; }
    const bytes = await readFile(target); response.setHeader('Content-Type', types[path.extname(target)] || 'application/octet-stream'); response.end(bytes);
  } catch { response.statusCode = 404; response.end(); }
}).listen(8789, '127.0.0.1', () => process.stdout.write('ARC fictional UI review: http://127.0.0.1:8789\n'));
