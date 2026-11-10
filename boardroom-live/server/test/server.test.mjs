import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer, fakeClient, validateTurn, validateMinutes, resolveStatic, hasCredentials, InputError, DEFAULT_APP_DIR } from '../server.mjs';

async function withServer(opts, fn) {
  const srv = createServer(opts);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { await fn(base); } finally { await new Promise(r => srv.close(r)); }
}
const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const turnBody = { system: 'You are the board.', messages: [{ role: 'user', content: 'Founder: should we launch?' }] };

test('validateTurn accepts a normal turn and strips extra fields', () => {
  const v = validateTurn({ ...turnBody, messages: [{ role: 'user', content: 'hi', extra: 1 }] });
  assert.deepEqual(v.messages, [{ role: 'user', content: 'hi' }]);
});

test('validateTurn rejects bad input', () => {
  for (const bad of [null, {}, { system: '', messages: [] }, { system: 's', messages: [{ role: 'system', content: 'x' }] },
    { system: 's', messages: [{ role: 'assistant', content: 'x' }] }, { system: 's', messages: [{ role: 'user', content: '' }] },
    { system: 's', messages: Array.from({ length: 61 }, () => ({ role: 'user', content: 'x' })) }]) {
    assert.throws(() => validateTurn(bad), InputError);
  }
  assert.throws(() => validateMinutes({ prompt: '' }), InputError);
});

test('resolveStatic keeps requests inside the app folder', () => {
  const app = DEFAULT_APP_DIR;
  assert.equal(resolveStatic(app, '/'), path.join(app, 'index.html'));
  assert.equal(resolveStatic(app, '/video/elena-still.jpg?x=1'), path.join(app, 'video', 'elena-still.jpg'));
  for (const p of ['/../server/server.mjs', '/%2e%2e/%2e%2e/etc/passwd', '/..%2fserver.mjs']) {
    const r = resolveStatic(app, p);
    assert.ok(r === null || r.startsWith(app + path.sep), `${p} escaped to ${r}`);
  }
  assert.equal(resolveStatic(app, '/%E0%A4%A'), null);
});

test('hasCredentials looks at env vars and the ant profile', () => {
  assert.equal(hasCredentials({}, ''), false);
  assert.equal(hasCredentials({ ANTHROPIC_API_KEY: 'k' }, ''), true);
  assert.equal(hasCredentials({ ANTHROPIC_PROFILE: 'work' }, ''), true);
});

test('health reports whether Claude is available', async () => {
  await withServer({}, async base => assert.deepEqual(await (await fetch(base + '/api/health')).json(), { llm: false, mode: 'off' }));
  await withServer({ client: fakeClient(), mode: 'fake' }, async base => assert.equal((await (await fetch(base + '/api/health')).json()).llm, true));
});

test('without credentials the API refuses cleanly', async () => {
  await withServer({}, async base => {
    const r = await post(base, '/api/turn', turnBody);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).code, 'unavailable');
  });
});

test('/api/turn streams NDJSON text and ends with done', async () => {
  await withServer({ client: fakeClient(), mode: 'fake' }, async base => {
    const r = await post(base, '/api/turn', turnBody);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /ndjson/);
    const events = (await r.text()).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(events.at(-1).type, 'done');
    const text = events.filter(e => e.type === 'text').map(e => e.text).join('');
    assert.match(text, /^DEVON: /m);
    assert.match(text, /^MARCUS: /m);
    assert.match(text, /^ELENA: /m);
  });
});

test('/api/turn sends the expected Claude request', async () => {
  let seen;
  const spy = { beta: { messages: { stream(params) { seen = params; const it = (async function* () {
    yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ELENA: Hi.\n' } };
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
  })(); it.abort = () => {}; return it; } } } };
  await withServer({ client: spy }, async base => { await (await post(base, '/api/turn', turnBody)).text(); });
  assert.equal(seen.model, 'claude-opus-5-5');
  assert.equal(seen.system, turnBody.system);
  assert.deepEqual(seen.messages, turnBody.messages);
  assert.equal(seen.fallbacks, 'default');
  assert.deepEqual(seen.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(seen.output_config.effort, 'low');
  assert.equal(seen.thinking, undefined); // Opus 5.5 rejects disabled thinking; effort is the only control
});

test('/api/turn reports refusals and upstream errors as stream events', async () => {
  const refusing = { beta: { messages: { stream() { const it = (async function* () { yield { type: 'message_delta', delta: { stop_reason: 'refusal' } }; })(); it.abort = () => {}; return it; } } } };
  await withServer({ client: refusing }, async base => {
    const last = (await (await post(base, '/api/turn', turnBody)).text()).trim().split('\n').map(JSON.parse).at(-1);
    assert.deepEqual(last, { type: 'error', code: 'refused' });
  });
  const limited = { beta: { messages: { stream() { const it = (async function* () { throw Object.assign(new Error('slow down'), { status: 429 }); })(); it.abort = () => {}; return it; } } } };
  await withServer({ client: limited }, async base => {
    const last = (await (await post(base, '/api/turn', turnBody)).text()).trim().split('\n').map(JSON.parse).at(-1);
    assert.deepEqual(last, { type: 'error', code: 'rate_limited' });
  });
});

test('/api/turn rejects invalid JSON and bad shapes with 400', async () => {
  await withServer({ client: fakeClient() }, async base => {
    assert.equal((await post(base, '/api/turn', '{nope')).status, 400);
    assert.equal((await post(base, '/api/turn', { system: 's', messages: [] })).status, 400);
  });
});

test('/api/minutes returns parsed minutes and asks for structured output', async () => {
  await withServer({ client: fakeClient() }, async base => {
    const m = await (await post(base, '/api/minutes', { prompt: 'Write minutes' })).json();
    assert.equal(m.title, 'Demo board meeting');
    assert.equal(m.actions[0].owner, 'Founder');
  });
  let seen;
  const spy = { beta: { messages: { async create(p) { seen = p; return { stop_reason: 'refusal', content: [] }; } } } };
  await withServer({ client: spy }, async base => {
    const r = await post(base, '/api/minutes', { prompt: 'Write minutes' });
    assert.equal(r.status, 422);
    assert.equal((await r.json()).code, 'refused');
  });
  assert.equal(seen.output_config.format.type, 'json_schema');
  assert.equal(seen.fallbacks, 'default');
});

test('static files are served with the right types', async () => {
  await withServer({}, async base => {
    const html = await fetch(base + '/');
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type'), /text\/html/);
    assert.match(await html.text(), /claude-shim\.js/);
    assert.match((await fetch(base + '/kokoro-worker.mjs')).headers.get('content-type'), /javascript/);
    assert.equal((await fetch(base + '/kokoro/ort/ort-wasm-simd-threaded.wasm', { method: 'HEAD' })).headers.get('content-type'), 'application/wasm');
    assert.equal((await fetch(base + '/nope.js')).status, 404);
    assert.equal((await fetch(base + '/api/turn')).status, 404);
  });
});
