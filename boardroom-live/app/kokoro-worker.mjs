// Kokoro-82M (Apache-2.0) text-to-speech, running entirely in the browser.
// Model: kokoro-onnx int8 export (MIT). Runtime: onnxruntime-web (MIT). Phonemes: phonemizer / espeak-ng (Apache-2.0 build).
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.mjs';
import { phonemize } from 'https://cdn.jsdelivr.net/npm/phonemizer@1.2.1/+esm';

const BASE = new URL('./kokoro/', self.location.href).href;
const PARTS = 7, MODEL_BYTES = 92361271, MODEL_KEY = 'kokoro-v1.0-int8';
let session = null, vocab = null;
const voices = new Map();

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = {
  mjs: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort-wasm-simd-threaded.mjs',
  wasm: BASE + 'ort/ort-wasm-simd-threaded.wasm'
};

/* ---------- one-time download, kept in this browser ---------- */
function idb(){
  return new Promise((res, rej) => {
    const r = indexedDB.open('boardroom-voices', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function cacheGet(key){
  try{ const db = await idb(); return await new Promise(res => { const q = db.transaction('files').objectStore('files').get(key); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); }
  catch(_){ return null; }
}
async function cachePut(key, val){
  try{ const db = await idb(); await new Promise(res => { const t = db.transaction('files','readwrite'); t.objectStore('files').put(val, key); t.oncomplete = res; t.onerror = res; }); }
  catch(_){}
}
async function loadModel(){
  let buf = await cacheGet(MODEL_KEY);
  if(buf && buf.byteLength === MODEL_BYTES){ post({type:'progress', p:1, cached:true}); return buf; }
  const out = new Uint8Array(MODEL_BYTES); let off = 0;
  for(let i=0;i<PARTS;i++){
    const r = await fetch(BASE + `model.part${i}.wasm`);
    if(!r.ok) throw new Error('model download failed');
    const reader = r.body.getReader();
    for(;;){ const {done, value} = await reader.read(); if(done) break; out.set(value, off); off += value.length; post({type:'progress', p: off/MODEL_BYTES}); }
  }
  await cachePut(MODEL_KEY, out.buffer);
  return out.buffer;
}
async function voice(name){
  if(voices.has(name)) return voices.get(name);
  const r = await fetch(BASE + `voices/${name}.wasm`); const v = new Float32Array(await r.arrayBuffer());
  voices.set(name, v); return v;
}

/* ---------- text -> phonemes (ported from kokoro-js, Apache-2.0) ---------- */
function splitNum(e){ if(e.includes('.')) return e; if(e.includes(':')){ const [a,t]=e.split(':').map(Number); return t===0?`${a} o'clock`:t<10?`${a} oh ${t}`:`${a} ${t}`; }
  const a=parseInt(e.slice(0,4),10); if(a<1100||a%1000<10) return e; const h=e.slice(0,2), r=parseInt(e.slice(2,4),10), s=e.endsWith('s')?'s':'';
  if(a%1000>=100&&a%1000<=999){ if(r===0) return `${h} hundred${s}`; if(r<10) return `${h} oh ${r}${s}`; } return `${h} ${r}${s}`; }
function money(e){ const u=e[0]==='$'?'dollar':'pound'; if(isNaN(Number(e.slice(1)))) return `${e.slice(1)} ${u}s`;
  if(!e.includes('.')){ const pl=e.slice(1)==='1'?'':'s'; return `${e.slice(1)} ${u}${pl}`; }
  const [a,b]=e.slice(1).split('.'), n=parseInt(b.padEnd(2,'0'),10);
  return `${a} ${u}${a==='1'?'':'s'} and ${n} ${e[0]==='$'?(n===1?'cent':'cents'):(n===1?'penny':'pence')}`; }
function point(e){ const [a,b]=e.split('.'); return `${a} point ${b.split('').join(' ')}`; }
function normalise(t){
  return t.replace(/[‘’]/g,"'").replace(/«/g,'“').replace(/»/g,'”').replace(/[“”]/g,'"').replace(/\(/g,'«').replace(/\)/g,'»')
    .replace(/[^\S \n]/g,' ').replace(/  +/,' ')
    .replace(/\bD[Rr]\.(?= [A-Z])/g,'Doctor').replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g,'Mister').replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g,'Miss').replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g,'Mrs')
    .replace(/\betc\.(?! [A-Z])/gi,'etc').replace(/\b(y)eah?\b/gi,"$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g,splitNum).replace(/(?<=\d),(?=\d)/g,'')
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi,money)
    .replace(/\d*\.\d+/g,point).replace(/(?<=\d)-(?=\d)/g,' to ').replace(/(?<=\d)S/g,' S')
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g,"'S").replace(/(?<=X')S\b/g,'s')
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g,e=>e.replace(/\./g,'-')).replace(/(?<=[A-Z])\.(?=[A-Z])/gi,'-')
    .replace(/%/g,' percent').replace(/&/g,' and ').trim();
}
const PUNCT = new RegExp(`(\\s*[${';:,.!?¡¿—…"«»“”(){}[]'.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}]+\\s*)+`,'g');
async function toPhonemes(text){
  const t = normalise(text); const chunks=[]; let last=0;
  for(const m of t.matchAll(PUNCT)){ if(last<m.index) chunks.push({p:false, s:t.slice(last,m.index)}); if(m[0].length) chunks.push({p:true, s:m[0]}); last=m.index+m[0].length; }
  if(last<t.length) chunks.push({p:false, s:t.slice(last)});
  const parts = await Promise.all(chunks.map(async c => c.p ? c.s : (await phonemize(c.s,'en')).join(' ')));
  return parts.join('').replace(/ʲ/g,'j').replace(/r/g,'ɹ').replace(/x/g,'k').replace(/ɬ/g,'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g,' ').replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g,'z').trim();
}

/* ---------- synthesis ---------- */
async function synth(text, voiceName, speed){
  const ph = await toPhonemes(text);
  const ids = []; let kept = '';
  for(const ch of ph){ const id = vocab[ch]; if(id !== undefined){ ids.push(id); kept += ch; } }
  const n = Math.min(ids.length, 510); if(!n) return {audio:new Float32Array(0), phonemes:''};
  const tokens = new ort.Tensor('int64', BigInt64Array.from([0, ...ids.slice(0,n), 0].map(BigInt)), [1, n+2]);
  const v = await voice(voiceName); const row = Math.min(n, 510) - 1;
  const style = new ort.Tensor('float32', v.slice(row*256, row*256+256), [1,256]);
  const sp = new ort.Tensor('float32', new Float32Array([speed||1]), [1]);
  const out = await session.run({ tokens, style, speed: sp });
  return { audio: new Float32Array(out.audio.data), phonemes: kept.slice(0,n) };
}

function post(m, t){ self.postMessage(m, t||[]); }
let queue = Promise.resolve(), generation = 0;
self.onmessage = (e) => {
  const m = e.data;
  if(m.type === 'init'){
    (async () => {
      try{
        vocab = await (await fetch(BASE + 'vocab.json')).json();
        if(m.cachedOnly){ const c = await cacheGet(MODEL_KEY); if(!c || c.byteLength !== MODEL_BYTES){ post({type:'notcached'}); return; } }
        const buf = await loadModel();
        session = await ort.InferenceSession.create(buf, { executionProviders:['wasm'], graphOptimizationLevel:'all' });
        // speed test so the page can decide whether this device keeps up in real time
        const t0 = performance.now(); const r = await synth('Right, let me take that one.', m.benchVoice || 'bf_emma', 1);
        const rtf = (performance.now()-t0) / (r.audio.length/24000*1000);
        post({type:'ready', rtf});
      }catch(err){ post({type:'error', message: String(err && err.message || err)}); }
    })();
  } else if(m.type === 'speak'){
    const gen = generation;
    queue = queue.then(async () => {
      if(gen !== generation) return;
      try{
        const t0 = performance.now();
        const r = await synth(m.text, m.voice, m.speed);
        if(gen !== generation) return;
        post({type:'audio', id:m.id, audio:r.audio, phonemes:r.phonemes, ms: performance.now()-t0}, [r.audio.buffer]);
      }catch(err){ post({type:'failed', id:m.id, message:String(err && err.message || err)}); }
    });
  } else if(m.type === 'cancel'){
    generation++;
  }
};
