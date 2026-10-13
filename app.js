import { LIMITS, safeState, dueReminders, localIntent, modelMessages } from './core.mjs';
const $ = id => document.getElementById(id);
const STORAGE = 'arc-web-state-v1';
let state;
try { state = safeState(JSON.parse(localStorage.getItem(STORAGE) || '{}')); } catch { state = safeState({}); }
let worker = null, modelReady = false, loading = false, generating = false, request = 0, pending = new Map();
let recognizer = null, micTimer = null, imageBlob = null, imageURL = null, imageText = '', ocrBusy = false;
let imageRevision = 0, ocrOperation = null;
const OCR_DEADLINE_MS = 120000;
const uid = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
function save() {
  state = safeState(state);
  try { localStorage.setItem(STORAGE, JSON.stringify(state)); } catch { status('保存容量が足りません。会話の削除を試してください。',true); }
}
function status(text, error=false) { $('status-text').textContent=text; $('status-dot').dataset.state=error?'error':(generating||loading?'busy':'ready'); }
function message(role, content, persist=true) {
  const node=document.createElement('div'); node.className=`message ${role}`;
  const label=document.createElement('span'); label.className='message-label'; label.textContent=role==='user'?'YOU':'ARC';
  const body=document.createElement('p'); body.textContent=content; node.append(label,body); $('chat-messages').append(node);
  if(persist && role!=='status'){state.history.push({role,content});state.history=state.history.slice(-LIMITS.history);save();}
  $('chat-messages').scrollTop=$('chat-messages').scrollHeight;
}
function speak(text) {
  if(!state.voice || !('speechSynthesis' in window)) return;
  const utterance=new SpeechSynthesisUtterance(text); utterance.lang='ja-JP'; utterance.rate=1.02;
  const voice=speechSynthesis.getVoices().find(x=>x.lang.startsWith('ja')); if(voice)utterance.voice=voice;
  speechSynthesis.cancel(); speechSynthesis.speak(utterance);
}
function answer(text) { message('assistant',text); speak(text); }
function renderLists() {
  $('memories-list').replaceChildren(); $('reminders-list').replaceChildren();
  for(const [kind,list,id] of [['memories',state.memories,'memories-list'],['reminders',state.reminders.filter(x=>!x.done),'reminders-list']]){
    if(!list.length){const p=document.createElement('p');p.className='empty-state';p.textContent=kind==='memories'?'まだメモはありません。':'予定はありません。';$(id).append(p);}
    for(const item of list){const row=document.createElement('div');row.className='saved-row';const text=document.createElement('span');text.textContent=kind==='reminders'?`${new Date(item.at).toLocaleString('ja-JP')} · ${item.text}`:item.text;const button=document.createElement('button');button.type='button';button.className='delete-button';button.textContent='削除';button.setAttribute('aria-label',`${item.text}を削除`);button.onclick=()=>{state[kind]=state[kind].filter(x=>x.id!==item.id);save();renderLists();};row.append(text,button);$(id).append(row);}
  }
}
function remember(text){state.memories.push({id:uid(),text:text.slice(0,500)});save();renderLists();}
function remind(text,at){state.reminders.push({id:uid(),text:text.slice(0,200),at,done:false});save();renderLists();}
function checkReminders(){if(document.hidden)return;const due=dueReminders(state.reminders,Date.now());if(!due.length)return;for(const item of due)item.done=true;save();for(const item of due)answer(`リマインダー：${item.text}`);save();renderLists();}
function busy(value){generating=value;$('send-button').textContent=value?'停止':'送信';$('send-button').setAttribute('aria-label',value?'AIの回答を停止':'メッセージを送信');$('model-load-button').disabled=loading||value;}
function disposeWorker(){worker?.terminate();worker=null;modelReady=false;loading=false;for(const item of pending.values())item.reject(new Error('処理を停止しました。'));pending.clear();}
function workerCall(type,data={}){const id=++request;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});worker.postMessage({id,type,...data});});}
function makeWorker(){worker=new Worker('./ai-worker.js',{type:'module'});worker.onmessage=event=>{const data=event.data;if(data.type==='progress'){if(Number.isFinite(data.progress)){$('model-progress').value=data.progress;$('model-status').textContent=`AIを準備中 · ${Math.round(data.progress)}%`;}return;}const item=pending.get(data.id);if(!item)return;pending.delete(data.id);if(data.type==='error'){const error=new Error(data.message||'端末内AIを開始できませんでした。');error.code=data.code;error.canRetryWasm=data.canRetryWasm===true;item.reject(error);}else item.resolve(data);};worker.onerror=()=>{disposeWorker();busy(false);$('model-status').textContent='AIを再読み込みしてください。';status('AIを動かすメモリが不足したか、通信が切れました。ほかのタブを閉じて再度お試しください。',true);};}
async function loadModel(device){if(loading||generating||ocrBusy)return;disposeWorker();makeWorker();loading=true;$('model-load-button').disabled=true;$('model-progress').hidden=false;$('model-progress').removeAttribute('value');status('端末内AIを準備しています');$('model-status').textContent='初回は約300〜400MBをダウンロードします。';try{const data=await workerCall('load',{device});modelReady=true;$('model-status').textContent=`端末内AI · ${data.device==='webgpu'?'GPU':'CPU'} · 準備完了`;$('model-load-button').textContent='AIを再読み込み';delete $('model-load-button').dataset.device;status('話しかけてください');}catch(error){disposeWorker();$('model-status').textContent='AIを開始できませんでした。';status(error.message,true);message('status',error.message,false);$('model-load-button').textContent=error.canRetryWasm?'CPUで再試行（追加ダウンロードあり）':'AIを再試行';if(error.canRetryWasm)$('model-load-button').dataset.device='wasm';}finally{loading=false;$('model-load-button').disabled=false;$('model-progress').hidden=true;}}
async function send(event){event?.preventDefault();if(generating){disposeWorker();busy(false);$('model-status').textContent='AIを停止しました。再開には再読み込みが必要です。';status('回答を停止しました');return;}const text=$('message-input').value.trim();if(!text)return;if(text.length>LIMITS.input){status(`入力は${LIMITS.input}文字以内にしてください。`,true);return;}window.speechSynthesis?.cancel?.();recognizer?.stop();message('user',text);$('message-input').value='';const intent=localIntent(text);if(intent.type==='memory'){remember(intent.text);answer(`メモに保存しました：${intent.text}`);return;}if(intent.type==='memories'){answer(state.memories.length?state.memories.map(x=>`・${x.text}`).join('\n'):'まだメモはありません。「覚えて ○○」で保存できます。');return;}if(intent.type==='time'){answer(new Date(intent.at).toLocaleString('ja-JP'));return;}if(intent.type==='reminder'){remind(intent.text,intent.at);answer(`${new Date(intent.at).toLocaleTimeString('ja-JP')}に「${intent.text}」をお知らせします。ARCを開いている間に通知します。`);return;}if(!modelReady){message('status','AIを準備するボタンを押してください。「今何時」「覚えて ○○」やリマインダーは、AIのダウンロード前でも使えます。',false);return;}busy(true);status('考えています…');try{const data=await workerCall('generate',{messages:modelMessages(state.history,state.memories)});if(data.reply?.trim())answer(data.reply.trim());else message('status','回答を作れませんでした。短い質問で再度お試しください。',false);status('話しかけてください');}catch(error){if(error.code==='generation-failed'||error.code==='not-ready'){disposeWorker();$('model-status').textContent='AIを再読み込みしてください。';if(error.canRetryWasm){$('model-load-button').dataset.device='wasm';$('model-load-button').textContent='CPUで再試行';}}status(error.message,true);message('status',error.message,false);}finally{busy(false);}}
function startMic(){if(recognizer){recognizer.stop();return;}const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;if(!Recognition){status('このブラウザでは音声入力を使えません。iPhoneのキーボードのマイク、または文字入力を使ってください。',true);return;}window.speechSynthesis?.cancel?.();const baseline=$('message-input').value;recognizer=new Recognition();recognizer.lang='ja-JP';recognizer.interimResults=true;recognizer.continuous=false;$('mic-button').setAttribute('aria-pressed','true');status('聞いています…');recognizer.onresult=event=>{let transcript='';for(let i=0;i<event.results.length;i++)transcript+=event.results[i][0].transcript;$('message-input').value=(baseline+(baseline?' ':'')+transcript).slice(0,LIMITS.input);};recognizer.onerror=event=>status(event.error==='not-allowed'?'マイクの許可を確認してください。':'音声入力を開始できませんでした。文字入力も使えます。',true);recognizer.onend=()=>{clearTimeout(micTimer);recognizer=null;$('mic-button').setAttribute('aria-pressed','false');status('内容を確認して送信してください');};try{recognizer.start();micTimer=setTimeout(()=>recognizer?.stop(),60000);}catch{recognizer=null;$('mic-button').setAttribute('aria-pressed','false');status('音声入力を開始できませんでした。',true);}}
async function pickImage(file){if(!file||ocrBusy)return;if(file.size>15*1024*1024){status('写真は15MB以下にしてください。',true);return;}clearImage();const revision=imageRevision;let url;try{url=URL.createObjectURL(file);const img=new Image();await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;img.src=url;});if(revision!==imageRevision)return;const scale=Math.min(1,1200/Math.max(img.width,img.height));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.9));if(revision!==imageRevision)return;if(!blob)throw new Error();imageBlob=blob;imageURL=URL.createObjectURL(imageBlob);$('attachment-preview').src=imageURL;$('attachment-preview').hidden=false;$('attachment-clear').hidden=false;$('ocr-button').hidden=false;$('ocr-button').disabled=false;$('ocr-status').textContent='写真内の文字を読み取れます。画像の内容全体の認識には対応していません。';}catch{if(revision===imageRevision)status('写真を読み込めませんでした。JPEGやPNGでお試しください。',true);}finally{if(url)URL.revokeObjectURL(url);}}
function clearImage(){imageRevision++;cancelOCR('写真を変更したため、文字の読み取りを停止しました。');if(imageURL)URL.revokeObjectURL(imageURL);imageBlob=null;imageURL=null;imageText='';$('attachment-preview').removeAttribute('src');$('attachment-preview').hidden=true;$('attachment-clear').hidden=true;$('ocr-button').hidden=true;$('ocr-status').textContent='';$('camera-input').value='';}
let tesseractPromise;
function loadOCR(){if(!tesseractPromise)tesseractPromise=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';script.onload=()=>window.Tesseract?resolve(window.Tesseract):reject(new Error());script.onerror=reject;document.head.append(script);}).catch(error=>{tesseractPromise=null;throw error;});return tesseractPromise;}
function terminateOCR(operation){if(!operation?.worker||operation.workerTerminated)return;operation.workerTerminated=true;try{void Promise.resolve(operation.worker.terminate()).catch(()=>{});}catch{/* Cleanup must not keep the UI locked. */}}
function stopOCR(operation,message,code='ocr-cancelled'){if(!operation||operation.stopped||operation.finished)return;operation.stopped=true;operation.reject(Object.assign(new Error(message),{code}));terminateOCR(operation);}
function cancelOCR(message='文字の読み取りを停止しました。'){stopOCR(ocrOperation,message);}
function currentOCR(operation){return ocrOperation===operation&&!operation.stopped&&operation.revision===imageRevision;}
async function readPhoto(){
  if(ocrBusy){cancelOCR();return;}
  if(!imageBlob)return;
  if(loading||generating){$('ocr-status').textContent='AIの処理が終わってから文字を読み取ってください。';return;}
  if(modelReady){disposeWorker();$('model-status').textContent='写真を読み取るためAIを停止しました。会話には再読み込みが必要です。';}
  const operation={revision:imageRevision,blob:imageBlob,worker:null,workerTerminated:false,stopped:false,finished:false,reject:null,timer:null};
  ocrOperation=operation;ocrBusy=true;
  $('camera-button').disabled=true;$('attachment-clear').disabled=true;$('model-load-button').disabled=true;
  $('ocr-button').disabled=false;$('ocr-button').textContent='読み取りを停止';
  $('ocr-status').textContent='文字を読み取り中… 初回は読み取りデータをダウンロードします（最大2分）。';
  const stopped=new Promise((_,reject)=>{operation.reject=reject;});
  operation.timer=setTimeout(()=>stopOCR(operation,'読み取りが2分以内に完了しませんでした。通信状況を確認して、もう一度お試しください。','ocr-timeout'),OCR_DEADLINE_MS);
  const work=(async()=>{
    const lib=await loadOCR();
    if(!currentOCR(operation))throw new Error('ocr-stale');
    operation.worker=await lib.createWorker('jpn+eng',1,{logger:()=>{},workerPath:'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/worker.min.js',corePath:'https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0'});
    if(!currentOCR(operation)){terminateOCR(operation);throw new Error('ocr-stale');}
    const result=await operation.worker.recognize(operation.blob);
    if(!currentOCR(operation))throw new Error('ocr-stale');
    return result.data.text.trim().slice(0,540);
  })();
  try{
    const text=await Promise.race([work,stopped]);
    if(!currentOCR(operation))return;
    imageText=text;
    if(!imageText){$('ocr-status').textContent='文字を見つけられませんでした。明るい場所で文字を大きく撮影してください。';return;}
    $('message-input').value=`写真から読み取った文字を説明してください：\n${imageText}`;
    $('ocr-status').textContent='文字を入力欄に入れました。誤りがないか確認して送信してください。';$('message-input').focus();
  }catch(error){
    if(ocrOperation===operation&&operation.revision===imageRevision)$('ocr-status').textContent=['ocr-cancelled','ocr-timeout'].includes(error.code)?error.message:'文字を読み取れませんでした。通信状況を確認し、別の写真でお試しください。';
  }finally{
    operation.finished=true;operation.stopped=true;clearTimeout(operation.timer);terminateOCR(operation);
    if(ocrOperation===operation){ocrOperation=null;ocrBusy=false;$('camera-button').disabled=false;$('attachment-clear').disabled=false;$('ocr-button').textContent='写真の文字を読み取る';$('ocr-button').disabled=!imageBlob;$('model-load-button').disabled=loading||generating;}
  }
}
$('chat-form').addEventListener('submit',send);
$('message-input').maxLength=LIMITS.input;$('message-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();send();}});
$('model-load-button').onclick=()=>loadModel($('model-load-button').dataset.device);
$('mic-button').onclick=startMic;$('camera-button').onclick=()=>$('camera-input').click();$('camera-input').onchange=()=>pickImage($('camera-input').files[0]);$('attachment-clear').onclick=clearImage;$('ocr-button').onclick=readPhoto;
for(const [button,dialog,close] of [['settings-button','settings-dialog','settings-close'],['install-help-button','install-dialog','install-close']]){$(button).onclick=()=>$(dialog).showModal();$(close).onclick=()=>$(dialog).close();$(dialog).addEventListener('click',event=>{if(event.target===$(dialog)){const r=$(dialog).getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)$(dialog).close();}});}
$('voice-toggle').checked=state.voice;$('voice-toggle').onchange=()=>{state.voice=$('voice-toggle').checked;save();if(!state.voice)window.speechSynthesis?.cancel?.();};
$('memory-save-button').onclick=()=>{const text=$('memory-input').value.trim();if(text){remember(text);$('memory-input').value='';status('メモを保存しました');}};
$('reminder-save-button').onclick=()=>{const text=$('reminder-text').value.trim();const at=new Date($('reminder-datetime').value).getTime();if(!text||!Number.isFinite(at)||at<=Date.now()){status('予定の内容と未来の日時を入力してください。',true);return;}remind(text,at);$('reminder-text').value='';status('リマインダーを保存しました');};
$('clear-history-button').onclick=()=>{if(!confirm('この端末の会話履歴を削除しますか？ メモと予定は残ります。'))return;if(generating){disposeWorker();busy(false);$('model-status').textContent='AIを再読み込みしてください。';}state.history=[];save();$('chat-messages').replaceChildren();message('status','会話履歴を削除しました。',false);};
$('chat-messages').replaceChildren();$('send-button').disabled=false;clearImage();
state.history.forEach(x=>message(x.role,x.content,false));if(!state.history.length)message('status','こんにちは、ARCです。無料の端末内AIを準備すると会話できます。「覚えて ○○」やリマインダーは、準備前でも使えます。',false);
renderLists();status('準備できたら、話しかけてください');setInterval(checkReminders,1000);checkReminders();
document.addEventListener('visibilitychange',()=>{if(document.hidden){recognizer?.stop();window.speechSynthesis?.cancel?.();}else checkReminders();});
window.addEventListener('pagehide',()=>{recognizer?.stop();cancelOCR('画面を離れたため、文字の読み取りを停止しました。');disposeWorker();});
window.addEventListener('pageshow',event=>{if(event.persisted){busy(false);$('model-status').textContent='端末内AIを再読み込みしてください。';}});
// Owner-private hosting must re-check access online. Do not cache an authenticated page.
if('serviceWorker'in navigator)navigator.serviceWorker.getRegistrations().then(registrations=>Promise.all(registrations.filter(r=>r.scope===new URL('./',location.href).href).map(r=>r.unregister()))).catch(()=>{});
if('caches'in window)caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('arc-shell-')).map(k=>caches.delete(k)))).catch(()=>{});
