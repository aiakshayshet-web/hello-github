/* Self-hosted stand-in for the claude.ai artifact capabilities that index.html asks for with
 * window.claude.use(name). Inside a claude.ai artifact the real window.claude exists and this file
 * does nothing, so the same index.html runs in both places.
 *
 *   sample     -> POST /api/turn (streamed NDJSON) and POST /api/minutes on this server
 *   dictation  -> the browser's SpeechRecognition (Chrome, Edge, Safari)
 *   downloads  -> a normal <a download> link
 *   tts        -> null, so the page uses Kokoro or the browser's own voices
 */
(function () {
  'use strict';
  if (window.claude && window.claude.use) return;

  const err = (code, message, extra) => Object.assign(new Error(message || code), { code }, extra || {});

  /* ---------- sample: Claude through our backend ---------- */
  // index.html sends the system prompt as the first user message (that is how the artifact API works).
  // Move it to a real system prompt for the Messages API.
  function splitSystem(msgs) {
    if (msgs.length > 1 && msgs[0].role === 'user') return { system: msgs[0].content, messages: msgs.slice(1) };
    return { system: 'You are a helpful advisory board.', messages: msgs };
  }

  async function readNdjson(body, onEvent) {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line) onEvent(JSON.parse(line));
      }
    }
    if (buf.trim()) onEvent(JSON.parse(buf));
  }

  async function sample(msgs, opts) {
    opts = opts || {};
    const payload = splitSystem(msgs);
    let text = '';
    let res;
    try {
      res = await fetch('/api/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: opts.signal });
    } catch (e) {
      if (e && e.name === 'AbortError') throw Object.assign(e, { code: 'aborted', text });
      throw err('upstream_error', 'network error', { text });
    }
    if (!res.ok) {
      let code = res.status === 429 ? 'rate_limited' : 'upstream_error';
      try { const j = await res.json(); if (j && j.code) code = j.code; } catch (_) {}
      throw err(code, 'turn failed', { text });
    }
    let failure = null;
    try {
      await readNdjson(res.body, ev => {
        if (ev.type === 'text') { text += ev.text; if (opts.onText) opts.onText({ text }); }
        else if (ev.type === 'error') failure = ev.code || 'upstream_error';
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw Object.assign(e, { code: 'aborted', text });
      throw err('upstream_error', 'stream broke', { text });
    }
    if (failure) throw err(failure, 'turn failed', { text });
    return { text };
  }

  sample.json = async function (prompt) {
    const res = await fetch('/api/minutes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }) });
    let j = null;
    try { j = await res.json(); } catch (_) {}
    if (!res.ok) throw err((j && j.code) || (res.status === 429 ? 'rate_limited' : 'upstream_error'), 'minutes failed');
    return j;
  };

  /* ---------- dictation: Web Speech API ---------- */
  function makeDictation() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const subs = { partial: [], final: [], state: [] };
    const emit = (k, v) => subs[k].forEach(f => { try { f(v); } catch (e) { console.error(e); } });
    let rec = null, stopping = false, lastError = null, stopWaiters = [];
    const ERR = { 'not-allowed': 'not_granted', 'service-not-allowed': 'not_granted', 'audio-capture': 'unavailable', network: 'upstream_error', 'language-not-supported': 'unavailable' };

    return {
      onPartial(f) { subs.partial.push(f); },
      onFinal(f) { subs.final.push(f); },
      onState(f) { subs.state.push(f); },
      start() {
        return new Promise((resolve, reject) => {
          if (rec) return resolve();
          rec = new SR();
          rec.lang = document.documentElement.lang === 'en' ? 'en-GB' : (navigator.language || 'en-GB');
          rec.continuous = true;
          rec.interimResults = true;
          stopping = false; lastError = null;
          let started = false;
          rec.onstart = () => { started = true; emit('state', { state: 'listening' }); resolve(); };
          rec.onresult = e => {
            let partial = '';
            for (let i = e.resultIndex; i < e.results.length; i++) {
              const r = e.results[i], t = r[0] ? r[0].transcript : '';
              if (r.isFinal) { if (t.trim()) emit('final', { text: ' ' + t.trim() }); }
              else partial += t;
            }
            if (partial.trim()) emit('partial', { text: partial.trim() });
          };
          rec.onerror = e => { if (e.error !== 'no-speech' && e.error !== 'aborted') lastError = ERR[e.error] || 'upstream_error'; };
          rec.onend = () => {
            rec = null;
            const reason = stopping ? 'stopped' : (lastError || 'ended');
            emit('state', { state: 'idle', reason });
            stopWaiters.splice(0).forEach(f => f());
            if (!started) reject(err(lastError || 'unavailable', 'could not start the microphone'));
          };
          emit('state', { state: 'starting' });
          try { rec.start(); } catch (e) { rec = null; reject(err('unavailable', e.message)); }
        });
      },
      stop() {
        if (!rec) return Promise.resolve();
        stopping = true;
        return new Promise(resolve => { stopWaiters.push(resolve); try { rec.stop(); } catch (_) { resolve(); } });
      },
    };
  }

  /* ---------- downloads ---------- */
  const downloads = {
    async save({ filename, data, mimeType }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType || 'text/markdown;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = filename || 'download';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    },
  };

  /* ---------- wiring ---------- */
  let health = null;
  const getHealth = () => health || (health = fetch('/api/health').then(r => r.ok ? r.json() : { llm: false }).catch(() => ({ llm: false })));

  window.claude = {
    selfHosted: true,
    use(name) {
      if (name === 'sample') return getHealth().then(h => (h.llm ? sample : null));
      if (name === 'dictation') return Promise.resolve(makeDictation());
      if (name === 'downloads') return Promise.resolve(downloads);
      return Promise.resolve(null);
    },
  };
  window.__boardroomShim = { splitSystem, readNdjson };
})();
