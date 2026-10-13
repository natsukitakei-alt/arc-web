// Japanese task suggestions from verified structured Slack evidence. No model or external AI.
const USER_ID=/^[UW][A-Z0-9]{6,20}$/, CHANNEL_ID=/^[CDG][A-Z0-9]{6,20}$/, TS=/^\d{10,13}\.\d{1,6}$/;
const DAY=86400000,JST=9*3600000;
const badResponse=()=>new Error('invalid_evidence');
function isSlackHost(host){return typeof host==='string'&&/^[a-z0-9][a-z0-9-]*\.slack\.com$/i.test(host);}
function tsDigits(ts){const[seconds,fraction]=ts.split('.');return seconds+fraction.padEnd(6,'0');}
export function validateSlackSourceUrl(raw,expected={}){
  try{const url=new URL(raw);if(url.protocol!=='https:'||url.username||url.password||url.port||!isSlackHost(url.hostname))return null;if(expected.slackHost&&url.hostname!==expected.slackHost.toLowerCase())return null;
  const path=url.pathname.match(/^\/archives\/([CDG][A-Z0-9]{6,20})\/p(\d{16,19})$/);if(!path||(expected.channelId&&path[1]!==expected.channelId)||(expected.ts&&path[2]!==tsDigits(expected.ts)))return null;
  const rootTs=url.searchParams.get('thread_ts'),cid=url.searchParams.get('cid');if((cid&&cid!==path[1])||(rootTs&&(!TS.test(rootTs)||(expected.ts&&Number(rootTs)>Number(expected.ts)))))return null;
  const safe=new URL(url.origin+url.pathname);if(rootTs){safe.searchParams.set('thread_ts',rootTs);safe.searchParams.set('cid',path[1]);}return safe.href;}catch{return null;}
}
function normalize(text){return text.normalize('NFKC').replace(/\s+/g,' ').trim();}
const PROMPT=/(?:ignore (?:all|previous) instructions|system prompt|以前の指示を無視|指示を無視|システムプロンプト|あなたは.{0,100}(?:AI|アシスタント|トレーナー|演じ|患者|相談員)|ロールプレイ(?:ング)?|^\s*(?:system|assistant|user)\s*:)/im;
const ACK=/^(?:了解(?:しました|です)?|承知(?:しました|です)?|確認しました|ありがとうございます|ありがとう|助かります|はい|OK|よろしくお願いします)[!！。\s]*$/i;
const REQUEST=/(?:お願い(?:します|いたします|致します|できます|できません)|ください|下さい|いただけ|頂け|ご教示|ご教授|(?:確認|回答|返信|提出|送付|送信|共有|参加|承認|調整|連絡).{0,35}(?:お願いします|お願い|できますか|でしょうか|ますか))/;
const ACTION=/(?:確認|回答|返信|提出|送付|送信|共有|参加|承認|調整|連絡|教え|ご教示|ご教授|対応|修正|作成|登録|設定|変更|回収|報告|準備|購入|発注|送って|見て|見せ|知らせ|教えて)/;
const COMPLETE=/(?:対応済み(?:です)?|(?:確認|完了|提出|送付|送信|登録|修正|変更|共有|発注|回答|連絡)(?:しました|いたしました))(?![か?？]|ら)/;
const DELEGATE=/(?:返答待ち|回答待ち|返信待ち|確認待ち|結果待ち|確認をお願い|ご確認.{0,12}お願い|お願いします|お願いできます)/;
function requestParts(message){if(PROMPT.test(message.text)||/^\s*(?:\[自動通知\]|自動通知|通知:)/.test(message.text))return[];let inCode=false;const text=message.text.split('\n').filter(line=>{if(line.trim().startsWith('~~~')||line.trim().startsWith(String.fromCharCode(96).repeat(3))){inCode=!inCode;return false;}return !inCode&&!line.trim().startsWith('>');}).join('\n');return text.split(/\n+|(?<=[。！？?!])\s*/u).map(normalize).filter(p=>p&&!ACK.test(p)&&ACTION.test(p)&&REQUEST.test(p)).slice(0,3);}
function subjects(text){const clean=normalize(text).replace(/<[^>]+>/g,'').replace(/(?:今日|本日|明日|明後日)(?:中|まで)?(?:に)?/g,'').replace(/\d{1,2}時(?:\d{1,2}分)?(?:まで)?(?:に)?/g,'');return new Set([...clean.matchAll(/([\p{Letter}\p{Number}]{2,24}?)(?:を|について|の)/gu)].map(m=>m[1]).filter(s=>!/^(?:確認|対応|完了|こちら|これ|それ|その|この)$/.test(s)));}
function sharedSubject(a,b){const left=subjects(a);return [...subjects(b)].some(s=>left.has(s));}
function dateInJst(ms){return new Date(ms+JST);}
function dateAtJst(year,month,day,hour=23,minute=59,second=59){if(month<1||month>12||day<1||day>31||hour<0||hour>23||minute<0||minute>59)return null;const result=Date.UTC(year,month-1,day,hour,minute,second)-JST,check=dateInJst(result);return check.getUTCFullYear()===year&&check.getUTCMonth()===month-1&&check.getUTCDate()===day?result:null;}
function deadlineOf(text,sentMilliseconds){
  const sent=dateInJst(sentMilliseconds);let year=sent.getUTCFullYear(),month=sent.getUTCMonth()+1,day=sent.getUTCDate(),label=null;
  const exact=text.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})|(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日|(?:^|[^\d])(\d{1,2})\/(\d{1,2})(?!\d)/),relative=text.match(/明後日|明日|本日|今日/);
  if(exact){if(exact[1]){year=Number(exact[1]);month=Number(exact[2]);day=Number(exact[3]);}else if(exact[5]){if(exact[4])year=Number(exact[4]);month=Number(exact[5]);day=Number(exact[6]);}else{month=Number(exact[7]);day=Number(exact[8]);}label=exact[0];}
  else if(relative){const offset=relative[0]==='明日'?1:relative[0]==='明後日'?2:0,changed=new Date(Date.UTC(year,month-1,day)+offset*DAY);year=changed.getUTCFullYear();month=changed.getUTCMonth()+1;day=changed.getUTCDate();label=relative[0];}
  if(!label)return{deadline:null,deadlineLabel:/至急|急ぎ/.test(text)?'至急（日時指定なし）':'期限の指定なし'};
  const clock=text.match(/(?:^|[^\d])(\d{1,2})(?::(\d{2})|時(?:(\d{1,2})分)?)/),hour=clock?Number(clock[1]):23,minute=clock?Number(clock[2]??clock[3]??0):59,ms=dateAtJst(year,month,day,hour,minute,clock?0:59);
  return ms===null?{deadline:null,deadlineLabel:'期限の記載を確認してください'}:{deadline:new Date(ms).toISOString(),deadlineLabel:month+'/'+day+(clock?' '+String(hour).padStart(2,'0')+':'+String(minute).padStart(2,'0'):'中')+'（日本時間）'};
}
export function extractTasks(messages,currentUserId,now=new Date(),maxTasks=40){
  if(!USER_ID.test(currentUserId??'')||!Array.isArray(messages))throw badResponse();const nowMs=new Date(now).getTime();if(!Number.isFinite(nowMs))throw badResponse();const seen=new Set(),mention=new RegExp('<@'+currentUserId+'(?:\\|[^>]+)?>');
  const valid=messages.slice(0,300).filter(m=>{if(!CHANNEL_ID.test(m?.channelId??'')||!USER_ID.test(m?.userId??'')||!TS.test(m?.ts??'')||typeof m.text!=='string'||m.text.length>8000)return false;const key=m.channelId+':'+m.ts;if(seen.has(key))return false;seen.add(key);return Number(m.ts)*1000<=nowMs+60000&&validateSlackSourceUrl(m.url,{channelId:m.channelId,ts:m.ts});}).sort((a,b)=>Number(a.ts)-Number(b.ts)),groups=new Map();
  for(const m of valid){const threadTs=TS.test(m.threadTs??'')?m.threadTs:null,contextRootTs=!threadTs&&TS.test(m.contextRootTs??'')&&Number(m.contextRootTs)<=Number(m.ts)?m.contextRootTs:null,key=m.channelId+':'+(threadTs??contextRootTs??m.ts);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(m);}
  const tasks=[];
  for(const[rootKey,group]of groups){
    const incoming=group.filter(m=>m.userId!==currentUserId&&(m.channelId.startsWith('D')||mention.test(m.text))&&requestParts(m).length),ownRequests=group.filter(m=>m.userId===currentUserId&&m.verifiedAuthor===true&&(m.channelId.startsWith('D')||/<@[UW][A-Z0-9]+(?:\|[^>]+)?>/.test(m.text))&&requestParts(m).length),origin=incoming[0]??ownRequests[0];if(!origin)continue;
    const later=group.filter(m=>Number(m.ts)>Number(origin.ts)&&(!m.contextRootTs||(Number(m.ts)-Number(origin.ts)<172800&&sharedSubject(origin.text,m.text)))),ownReplies=later.filter(m=>m.userId===currentUserId&&m.verifiedAuthor===true&&!PROMPT.test(m.text)),lastOwn=ownReplies.at(-1),completed=lastOwn&&!ACK.test(normalize(lastOwn.text))&&COMPLETE.test(normalize(lastOwn.text))&&!/(?:未完了|まだ|していません|できません)/.test(lastOwn.text),reopened=completed&&later.some(m=>Number(m.ts)>Number(lastOwn.ts)&&m.userId!==currentUserId&&requestParts(m).length);
    let status=incoming.length?'todo':'waiting';if(completed&&!reopened)status='done';else if(lastOwn&&!ACK.test(normalize(lastOwn.text))&&DELEGATE.test(lastOwn.text)&&!later.some(m=>Number(m.ts)>Number(lastOwn.ts)&&m.userId!==currentUserId))status='waiting';
    const latestRequest=later.filter(m=>m.userId!==currentUserId&&requestParts(m).length).at(-1),evidence=reopened&&latestRequest?latestRequest:origin,title=requestParts(evidence).join(' / ').replace(/<@[UW][A-Z0-9]+(?:\|[^>]+)?>/g,'').replace(/<https?:\/\/[^>|]+\|([^>]+)>/g,'$1').trim().slice(0,150);if(!title)continue;
    tasks.push({id:rootKey,title,detail:origin.text.slice(0,650),status,...deadlineOf(evidence.text,Number(evidence.ts)*1000),sourceUrl:evidence.url,channelName:origin.channelName??origin.channelId,confidence:incoming.length?'high':'medium'});
  }
  const order={todo:0,waiting:1,done:2};return tasks.sort((a,b)=>order[a.status]-order[b.status]||(a.deadline?new Date(a.deadline).getTime():Infinity)-(b.deadline?new Date(b.deadline).getTime():Infinity)||a.id.localeCompare(b.id)).slice(0,Math.min(300,Math.max(1,maxTasks)));
}
