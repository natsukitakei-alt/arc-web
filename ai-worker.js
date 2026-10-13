/* ARC local text generation: WebLLM and Qwen2.5 (Apache-2.0).
 * No API key or inference server. Load only on the user's explicit request.
 * Stop loading/generation by terminating this dedicated worker.
 * iPhone/Safari model inference depends on hardware and available RAM.
 */
const LIBRARY_URL = 'https://esm.run/@mlc-ai/web-llm@0.2.86';
const MODEL_ID = 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC';
const MODEL_REVISION = '32ff081fe7e4dfe4ffb167b94c66fdf11e02b8ad';
const MODEL_URL = `https://huggingface.co/mlc-ai/${MODEL_ID}/resolve/${MODEL_REVISION}/`;
const LIMITS = Object.freeze({maxMessages:5,maxMessageCharacters:1200,maxInputCharacters:2000,contextWindowTokens:1024,maxNewTokens:128});
let phase = 'idle';
let engine = null;
let generating = false;
function post(id,type,fields={}) { self.postMessage({id,type,...fields}); }
function reportError(id,code,message) { post(id,'error',{code,message,canRetryWasm:false}); }
function ready(id) { post(id,'ready',{device:'webgpu',dtype:'q4f16_1',model:MODEL_ID,revision:MODEL_REVISION,limits:LIMITS}); }
async function load(id,requested) {
  if (requested !== undefined && !['auto','webgpu'].includes(requested)) {
    reportError(id,'unsupported-backend','この無料AIはGPU対応の端末でご利用ください。'); return;
  }
  if (phase === 'ready') { ready(id); return; }
  if (phase !== 'idle') {
    reportError(id,phase === 'loading' ? 'busy' : 'restart-required',phase === 'loading' ? 'AIを読み込んでいます。' : 'AIを停止してから、読み込み直してください。'); return;
  }
  phase = 'loading';
  try {
    // Reject unsupported hardware before fetching the library or weights.
    let adapter;
    try { adapter = await self.navigator?.gpu?.requestAdapter(); } catch { /* unavailable */ }
    if (!adapter?.features?.has('shader-f16')) {
      phase = 'idle';
      reportError(id,'unsupported-device','この端末では無料AIを開始できません。iPhoneではSafari・iOS 26以降の対応端末でお試しください。'); return;
    }
    post(id,'progress',{status:'library',device:'webgpu',dtype:'q4f16_1'});
    const {CreateMLCEngine,prebuiltAppConfig} = await import(LIBRARY_URL);
    const record = prebuiltAppConfig.model_list.find(item => item.model_id === MODEL_ID);
    // The library URL comes from this release's compatible prebuilt catalog:
    // v0_2_86/base/Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm.
    if (!record || !record.model_lib.includes('/v0_2_86/base/')) throw new Error('model-library-mismatch');
    const appConfig = {cacheBackend:'cache',model_list:[{...record,model:MODEL_URL,required_features:['shader-f16'],overrides:{...record.overrides,context_window_size:LIMITS.contextWindowTokens}}]};
    engine = await CreateMLCEngine(MODEL_ID,{appConfig,logLevel:'ERROR',initProgressCallback:event => {
      const value = Number.isFinite(event?.progress) ? Math.min(1,Math.max(0,event.progress)) : 0;
      post(id,'progress',{status:'loading',progress:value*100});
    }},{context_window_size:LIMITS.contextWindowTokens});
    phase = 'ready'; ready(id);
  } catch {
    phase = 'failed'; engine = null;
    reportError(id,'load-failed','AIを読み込めませんでした。通信環境と端末の空き容量を確認し、ほかのアプリを閉じて読み込み直してください。');
  }
}
function validateMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > LIMITS.maxMessages) throw new Error('invalid-messages');
  let count = 0;
  const cleaned = messages.map((message,index) => {
    if (!message || !['system','user','assistant'].includes(message.role) || typeof message.content !== 'string' || !message.content.trim() || message.content.length > LIMITS.maxMessageCharacters || (message.role === 'system' && index !== 0)) throw new Error('invalid-messages');
    count += message.content.length;
    return {role:message.role,content:message.content};
  });
  if (count > LIMITS.maxInputCharacters) throw new Error('context-too-long');
  if (cleaned.at(-1).role !== 'user') throw new Error('invalid-messages');
  // WebLLM owns the tokenizer. Its actual context-window check supplements
  // this bounded character limit; do not silently truncate the latest request.
  return cleaned;
}
async function generate(id,messages) {
  if (phase !== 'ready' || !engine) { reportError(id,'not-ready','先に「無料AIを読み込む」を押してください。'); return; }
  if (generating) { reportError(id,'busy','返答を作成しています。'); return; }
  generating = true;
  try {
    const cleaned = validateMessages(messages);
    const output = await engine.chat.completions.create({messages:cleaned,max_tokens:LIMITS.maxNewTokens,temperature:0.7,top_p:0.9,repetition_penalty:1.1});
    const reply = output?.choices?.[0]?.message?.content;
    if (typeof reply !== 'string' || !reply.trim()) throw new Error('empty-result');
    post(id,'result',{reply:reply.trim().slice(0,6000)});
  } catch (error) {
    // Forward no raw prompts, traces or URLs.
    const internal = `${error?.name || ''} ${error?.message || ''}`;
    const contextError = error?.message === 'context-too-long' || /context.*(?:window|length|size|exceed)|prompt.*(?:long|length)|input.*(?:too long|exceed)/i.test(internal);
    const code = contextError ? 'context-too-long' : ['invalid-messages','empty-result'].includes(error?.message) ? error.message : 'generation-failed';
    if (code === 'generation-failed') phase = 'failed';
    reportError(id,code,code === 'context-too-long' ? '会話が長くなりました。新しい会話で、短い文章を送ってください。' : code === 'invalid-messages' ? '文章を短くして、もう一度送信してください。' : code === 'empty-result' ? '返答を作成できませんでした。短い文章で、もう一度お試しください。' : '端末でAIを実行できませんでした。AIを停止してから、読み込み直してください。');
  } finally { generating = false; }
}
self.addEventListener('message',event => {
  const message = event.data;
  if (!message || !['string','number'].includes(typeof message.id) || (typeof message.id === 'number' && !Number.isFinite(message.id))) return;
  if (message.type === 'load') void load(message.id,message.device);
  else if (message.type === 'generate') void generate(message.id,message.messages);
  else reportError(message.id,'invalid-request','操作を確認してください。');
});
