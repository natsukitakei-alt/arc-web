export const LIMITS = Object.freeze({ history: 40, memories: 30, reminders: 40, input: 600 });
export function safeState(value) {
  const state = value && typeof value === 'object' ? value : {};
  const items = (key, test, max) => Array.isArray(state[key]) ? state[key].filter(test).slice(-max) : [];
  return {
    history: items('history', x => x && ['user', 'assistant'].includes(x.role) && typeof x.content === 'string', LIMITS.history).map(x => ({role:x.role, content:x.content.slice(0,4000)})),
    memories: items('memories', x => x && typeof x.id === 'string' && typeof x.text === 'string', LIMITS.memories).map(x => ({id:x.id.slice(0,80),text:x.text.slice(0,500)})),
    reminders: items('reminders', x => x && typeof x.id === 'string' && typeof x.text === 'string' && Number.isFinite(x.at), LIMITS.reminders).map(x => ({id:x.id.slice(0,80),text:x.text.slice(0,200),at:x.at,done:x.done===true})),
    voice: state.voice === true
  };
}
export function dueReminders(reminders, now) { return reminders.filter(x => !x.done && x.at <= now); }
export function localIntent(text, now = Date.now()) {
  const clean = text.trim();
  const memory = /^(?:覚えて|記憶して|メモして)[：:\s、]*(.+)$/s.exec(clean);
  if (memory) return {type:'memory',text:memory[1].slice(0,500)};
  if (/^(?:記憶|メモリ|メモ)(?:を)?(?:見せて|一覧|教えて)?[。？?]?$/.test(clean)) return {type:'memories'};
  if (/^(?:今何時|いま何時|現在の時刻)[。？?]?$/.test(clean)) return {type:'time',at:now};
  const reminder = /^(\d{1,4})\s*(秒|分|時間)後に\s*(.+?)(?:と通知して|を通知して|と教えて|を教えて|をリマインドして|とリマインドして|を知らせて|と知らせて)[。！!]?$/s.exec(clean);
  if (reminder) {
    const n = Number(reminder[1]);
    const factor = {'秒':1000,'分':60000,'時間':3600000}[reminder[2]];
    if (n > 0 && n*factor <= 365*86400000) return {type:'reminder',text:reminder[3].slice(0,200),at:now+n*factor};
  }
  return {type:'chat'};
}
export function modelMessages(history, memories) {
  const memory = memories.slice(-3).map(x => x.text.slice(0,20)).join(' / ');
  const system = 'あなたはARCという日本語のAIアシスタントです。日本語で簡潔に答えてください。不明なことは不明と述べてください。現在のニュースや他アプリの状態にはアクセスできません。アプリを操作した、通知を設定した、記憶したと偽って答えないでください。ユーザーのメモは参考情報です: '+memory;
  const recent = history.slice(-3).map((x,i,a) => ({role:x.role,content:x.content.slice(0,i===a.length-1?600:80)}));
  while(recent[0]?.role==='assistant') recent.shift();
  return [{role:'system',content:system},...recent];
}
