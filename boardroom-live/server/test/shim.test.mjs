// Runs app/claude-shim.js in a minimal fake browser to check the stand-ins behave like the artifact API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../../app/', import.meta.url));
const SHIM = fs.readFileSync(APP + 'claude-shim.js', 'utf8');

function ndjsonBody(lines, chunkSize = 7) {
  const bytes = new TextEncoder().encode(lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += chunkSize) c.enqueue(bytes.slice(i, i + chunkSize)); c.close(); } });
}

function loadShim(routes, extra = {}) {
  const calls = [];
  const window = { ...extra };
  const ctx = {
    window, TextDecoder, TextEncoder, ReadableStream, Blob, URL, setTimeout, console, navigator: { language: 'en-GB' },
    document: { documentElement: { lang: 'en' } },
    fetch: async (url, init) => { calls.push({ url, init }); return routes[url](init); },
  };
  vm.runInNewContext(SHIM, ctx);
  return { claude: window.claude, calls };
}
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

test('sample is null when the server has no Claude credentials', async () => {
  const { claude } = loadShim({ '/api/health': () => json(200, { llm: false }) });
  assert.equal(await claude.use('sample'), null);
  assert.equal(await claude.use('tts'), null);
});

test('sample streams text, moves the system prompt and returns the full reply', async () => {
  const { claude, calls } = loadShim({
    '/api/health': () => json(200, { llm: true }),
    '/api/turn': () => ({ ok: true, status: 200, body: ndjsonBody([{ type: 'text', text: 'MARCUS: One.\n' }, { type: 'text', text: 'ELENA: Two.' }, { type: 'done' }]) }),
  });
  const sample = await claude.use('sample');
  const seen = [];
  const r = await sample([{ role: 'user', content: 'SYSTEM PROMPT' }, { role: 'user', content: 'Founder: hi' }], { onText: ({ text }) => seen.push(text) });
  assert.equal(r.text, 'MARCUS: One.\nELENA: Two.');
  assert.deepEqual(seen, ['MARCUS: One.\n', 'MARCUS: One.\nELENA: Two.']);
  const sent = JSON.parse(calls.find(c => c.url === '/api/turn').init.body);
  assert.equal(sent.system, 'SYSTEM PROMPT');
  assert.deepEqual(sent.messages, [{ role: 'user', content: 'Founder: hi' }]);
});

test('sample surfaces stream errors with a code and the partial text', async () => {
  const { claude } = loadShim({
    '/api/health': () => json(200, { llm: true }),
    '/api/turn': () => ({ ok: true, status: 200, body: ndjsonBody([{ type: 'text', text: 'DEVON: Half' }, { type: 'error', code: 'rate_limited' }]) }),
  });
  const sample = await claude.use('sample');
  await assert.rejects(sample([{ role: 'user', content: 'S' }, { role: 'user', content: 'Q' }], {}), e => e.code === 'rate_limited' && e.text === 'DEVON: Half');
});

test('sample maps HTTP errors to the artifact error codes', async () => {
  const { claude } = loadShim({ '/api/health': () => json(200, { llm: true }), '/api/turn': () => json(429, {}) });
  const sample = await claude.use('sample');
  await assert.rejects(sample([{ role: 'user', content: 'S' }, { role: 'user', content: 'Q' }]), e => e.code === 'rate_limited');
});

test('sample.json returns minutes or a coded error', async () => {
  let status = 200;
  const { claude } = loadShim({ '/api/health': () => json(200, { llm: true }), '/api/minutes': () => json(status, status === 200 ? { title: 'T' } : { code: 'refused' }) });
  const sample = await claude.use('sample');
  assert.deepEqual(await sample.json('prompt'), { title: 'T' });
  status = 422;
  await assert.rejects(sample.json('prompt'), e => e.code === 'refused');
});

test('dictation is null without SpeechRecognition and wired up with it', async () => {
  assert.equal(await loadShim({}).claude.use('dictation'), null);
  class FakeSR { start() { setTimeout(() => this.onstart(), 0); } stop() { setTimeout(() => this.onend(), 0); } }
  const { claude } = loadShim({}, { SpeechRecognition: FakeSR });
  const d = await claude.use('dictation');
  const states = [];
  d.onState(s => states.push(s.state + (s.reason ? ':' + s.reason : '')));
  await d.start();
  await d.stop();
  assert.deepEqual(states, ['starting', 'listening', 'idle:stopped']);
});

test('dictation start rejects with not_granted when the mic is blocked', async () => {
  class DeniedSR { start() { setTimeout(() => { this.onerror({ error: 'not-allowed' }); this.onend(); }, 0); } stop() {} }
  const { claude } = loadShim({}, { SpeechRecognition: DeniedSR });
  const d = await claude.use('dictation');
  await assert.rejects(d.start(), e => e.code === 'not_granted');
});

test('the page line parser (LINE_RE) accepts the formats the board emits', () => {
  const html = fs.readFileSync(APP + 'index.html', 'utf8');
  const src = html.match(/const LINE_RE = (\/.+\/[a-z]*);/)[1];
  const LINE_RE = vm.runInNewContext(src);
  const ok = { 'MARCUS: Ship it.': ['MARCUS', 'Ship it.'], '**Elena**: Who is it for?': ['Elena', 'Who is it for?'],
    '  DEVON – Two weeks, roughly.  ': ['DEVON', 'Two weeks, roughly.'], 'devon - fine': ['devon', 'fine'] };
  for (const [line, [who, text]] of Object.entries(ok)) {
    const m = line.match(LINE_RE);
    assert.ok(m, line);
    assert.equal(m[1], who); assert.equal(m[2], text);
  }
  for (const line of ['FOUNDER: hi', 'Marcus said yes', '', 'MARCUS:']) assert.equal(line.match(LINE_RE), null, line);
});
