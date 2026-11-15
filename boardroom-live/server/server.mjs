// Boardroom Live backend: serves app/ and proxies Claude so the API key never reaches the browser.
//
//   POST /api/turn     {system, messages}  -> NDJSON stream: {"type":"text","text":"..."} ... {"type":"done"}
//   POST /api/json     {prompt}            -> the reply parsed as JSON (minutes, and every Roast-mode step)
//   GET  /api/health                       -> {"llm": true|false, "mode": "live"|"fake"|"off"}
//
// Env: ANTHROPIC_API_KEY (or any credential the SDK resolves), PORT (8080), BOARD_MODEL (claude-opus-5-5),
//      BOARD_FAKE=1 to stream canned replies with no API calls (demos and tests).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_APP_DIR = path.resolve(HERE, '..', 'app');
const MODEL = process.env.BOARD_MODEL || 'claude-opus-5-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.mp4': 'video/mp4',
  '.onnx': 'application/octet-stream', '.bin': 'application/octet-stream',
};

const LIMITS = { bodyBytes: 512 * 1024, messages: 60, contentChars: 20000, systemChars: 20000, promptChars: 80000 };

// Pull the JSON object out of a reply that may carry code fences or a sentence around it.
export function extractJson(text) {
  const t = String(text || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  const e = new Error('reply was not JSON'); e.code = 'invalid_json'; e.text = String(text || ''); throw e;
}

/* ---------- request validation (pure, exported for tests) ---------- */
export class InputError extends Error {}

export function validateTurn(body) {
  if (!body || typeof body !== 'object') throw new InputError('body must be a JSON object');
  const { system, messages } = body;
  if (typeof system !== 'string' || !system.trim() || system.length > LIMITS.systemChars) throw new InputError('system must be a non-empty string');
  if (!Array.isArray(messages) || !messages.length || messages.length > LIMITS.messages) throw new InputError(`messages must be 1-${LIMITS.messages} items`);
  const clean = messages.map((m, i) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) throw new InputError(`messages[${i}].role must be user or assistant`);
    if (typeof m.content !== 'string' || !m.content.trim() || m.content.length > LIMITS.contentChars) throw new InputError(`messages[${i}].content must be a non-empty string`);
    return { role: m.role, content: m.content };
  });
  if (clean[0].role !== 'user') throw new InputError('the first message must come from the user');
  return { system, messages: clean };
}

export function validateJsonRequest(body) {
  if (!body || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > LIMITS.promptChars) throw new InputError('prompt must be a non-empty string');
  return { prompt: body.prompt };
}

/* ---------- Claude calls ---------- */
function errorCode(e) {
  const s = e && e.status;
  if (s === 429) return 'rate_limited';
  if (s === 401 || s === 403) return 'not_granted';
  if (s === 529 || (s >= 500 && s < 600)) return 'upstream_error';
  if (e && (e.name === 'AbortError' || e.constructor?.name === 'APIUserAbortError')) return 'aborted';
  return 'upstream_error';
}

async function streamTurn(client, { system, messages }, res, signalClosed) {
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 4096,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    output_config: { effort: 'low' }, // spoken replies: latency matters more than depth
    system,
    messages,
  });
  signalClosed(() => stream.abort());
  let stop = null;
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') res.write(JSON.stringify({ type: 'text', text: ev.delta.text }) + '\n');
    else if (ev.type === 'message_delta' && ev.delta.stop_reason) stop = ev.delta.stop_reason;
  }
  res.write(JSON.stringify(stop === 'refusal' ? { type: 'error', code: 'refused' } : { type: 'done', stop_reason: stop }) + '\n');
}

async function askJson(client, { prompt }) {
  const r = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    output_config: { effort: 'medium' },
    messages: [{ role: 'user', content: prompt }],
  });
  if (r.stop_reason === 'refusal') { const e = new Error('refused'); e.code = 'refused'; throw e; }
  return extractJson(r.content.filter(b => b.type === 'text').map(b => b.text).join(''));
}

/* ---------- offline stand-in: canned board replies, no network ---------- */
const FAKE_SEATS = {
  Elena: { scores: [[8, 4, 3], [8, 5, 3], [8, 4, 2]], spoken: ['Option A. Hauliers feel this pain every week and will tell each other about a fix.', 'Marcus, the tech worry is real, but nobody pays for perfect architecture. I move nowhere.', 'Endorse. Get three paying hauliers before you polish anything.'] },
  Marcus: { scores: [[6, 7, 3], [7, 5, 3], [7, 4, 3]], spoken: ['I lean B. Operators have the systems and the budget, and the integration is the hard part.', 'Devon, your cash point lands. A is cheaper to test, so I move from B to A.', 'Endorse with an amendment: no hazardous-goods automation in the pilot.'] },
  Devon: { scores: [[7, 3, 5], [8, 3, 4], [8, 3, 3]], spoken: ['A, carefully. Two thousand pounds and three weeks gets you a measurable pilot.', 'Elena is right on demand. My condition is a hard stop if nobody pays by week six.', 'Endorse. Watch the cash, not the praise.'] },
};
function fakeJson(prompt) {
  const p = String(prompt);
  if (p.includes('into the council brief')) return {
    decision: 'Which side Freight AI should start on', business: 'Pre-revenue freight booking tool', resources: '20 hours a week, about £3,000', success: 'A paying pilot within six months', lean: 'Hauliers',
    options: [{ label: 'Hauliers first' }, { label: 'Ferry operators first' }, { label: "Don't do it", statusQuo: true }], assumptions: ['Savings cover year-one costs'], missing: [],
    weights: { elena: { weight: 3, reason: 'Which side wants it is a demand question' }, marcus: { weight: 2, reason: 'Integration risk' }, devon: { weight: 3, reason: 'Cash and founder time' } } };
  const round = /ROUND (\d) OF 3/.exec(p);
  const seat = /You are (Elena|Marcus|Devon),/.exec(p);
  if (round && seat) {
    const r = +round[1], f = FAKE_SEATS[seat[1]], [A, B, C] = f.scores[r - 1];
    const card = { scores: { A, B, C }, pillarScore: A, spoken: f.spoken[r - 1] };
    if (r === 1) return { ...card, stance: 'Yes', call: 'Option A', confidence: 3, ruinRisk: 'none', door: 'two-way', why: ['Demand', 'Cost', 'Speed'], risk: 'Nobody pays', changeMind: 'An operator offers a paid pilot', thisWeek: 'Ten calls', question: 'Who pays first?' };
    if (r === 2) return { ...card, stance: 'Yes', confidence: 4, ruinRisk: 'none', disagreeWith: seat[1] === 'Elena' ? 'marcus' : 'elena', rebuttal: 'Demand first', concede: 'Cash matters', moved: seat[1] === 'Marcus' ? 'yes, from B to A' : 'no', conditions: ['3 paying hauliers by week 6'] };
    return { ...card, vote: seat[1] === 'Marcus' ? 'Endorse with amendment' : 'Endorse', finalScore: 8, amendment: seat[1] === 'Marcus' ? 'No hazardous-goods automation in the pilot' : '', oneLine: 'Charge from day one.' };
  }
  if (p.includes('really fighting about')) return { cruxes: [{ question: 'Who pays inside six months?', sides: [{ position: 'Hauliers', seats: ['Elena', 'Devon'] }, { position: 'Operators', seats: ['Marcus'] }] }], note: 'Demand versus budget.', spoken: 'Round two. The real fight is who pays inside six months: hauliers who decide fast, or operators with budgets.' };
  if (p.includes('Write the draft resolution')) return { option: 'A', recommendation: 'Start with hauliers at £200 a month, run by hand first.', conditions: ['3 paying hauliers by week 6'], nextSteps: ['Book ten haulier calls this week'], cheapestTest: 'Run it by hand for three hauliers.', killCriteria: 'Fewer than 3 pay by week 6.', spoken: 'Draft resolution: hauliers first, two hundred pounds a month, run by hand. Round three, the vote.' };
  if (p.includes('The vote is in')) return { call: 'Start with hauliers, run by hand, and charge from day one.', why: [{ point: 'Hauliers decide fast', seat: 'Elena' }, { point: 'Cheapest to test', seat: 'Devon' }, { point: 'Integration can wait', seat: 'Marcus' }], fights: ['Marcus moved to hauliers on cost.'], minority: { seat: 'Marcus', view: 'Operators hold the budget.', wouldHaveToBeTrue: 'An operator signs a paid pilot within 90 days.' }, conditions: ['3 paying hauliers by week 6'], nextSteps: ['Book ten haulier calls this week'], cheapestTest: 'Three hauliers by hand for two weeks.', killCriteria: 'Fewer than 3 pay by week 6.', revisit: 'In six weeks.', spoken: 'The verdict is go. Start with hauliers, run it by hand, and charge from day one. First step: book ten haulier calls this week.' };
  return {
    title: 'Demo board meeting', summary: 'A canned meeting from the offline demo mode. No model was called.',
    decisions: ['Run a three-week pilot'], openQuestions: ['Who is the first customer?'],
    actions: [{ task: 'Name the first customer segment', owner: 'Founder', due: 'This week', priority: 'High' }],
    risks: [{ risk: 'Building the speech layer in-house', likelihood: 2, impact: 3, mitigation: 'Buy it for the pilot', raisedBy: 'Marcus' }] };
}

export function fakeClient() {
  const LINES = [
    'DEVON: Fair question. Rough numbers first: three weeks and about two thousand pounds gets you a pilot you can actually measure.',
    'MARCUS: Devon, two thousand only holds if we buy the speech layer instead of building it. Building it is a quarter of work nobody will thank us for.',
    'ELENA: And neither of you has said who it is for. Founder, which customer do you picture using this first?',
  ];
  return {
    beta: { messages: {
      stream() {
        let aborted = false;
        const events = (async function* () {
          for (const line of LINES) for (const word of (line + '\n').split(/(?<= )/)) {
            if (aborted) return;
            await new Promise(r => setTimeout(r, 15));
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: word } };
          }
          yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
        })();
        events.abort = () => { aborted = true; };
        return events;
      },
      async create({ messages }) {
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: '```json\n' + JSON.stringify(fakeJson(messages[0].content)) + '\n```' }] };
      },
    } },
  };
}

/* ---------- HTTP plumbing ---------- */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > LIMITS.bodyBytes) { reject(new InputError('request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { reject(new InputError('invalid JSON')); } });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

export function resolveStatic(appDir, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath.split('?')[0]); } catch { return null; }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(appDir, '.' + path.posix.normalize('/' + rel));
  if (file !== appDir && !file.startsWith(appDir + path.sep)) return null;
  return file;
}

export function createServer({ client, mode = client ? 'live' : 'off', appDir = DEFAULT_APP_DIR } = {}) {
  return http.createServer(async (req, res) => {
    const url = req.url || '/';
    try {
      if (url === '/api/health' && req.method === 'GET') return sendJson(res, 200, { llm: !!client, mode });

      if (url === '/api/turn' && req.method === 'POST') {
        if (!client) return sendJson(res, 503, { code: 'unavailable', error: 'No Claude credentials on the server' });
        const input = validateTurn(await readJson(req));
        res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
        let onClose = () => {};
        res.on('close', () => onClose());
        try { await streamTurn(client, input, res, fn => { onClose = fn; }); }
        catch (e) { if (!res.writableEnded) res.write(JSON.stringify({ type: 'error', code: errorCode(e) }) + '\n'); if (errorCode(e) !== 'aborted') console.error('[turn]', e.status || '', e.message); }
        return res.end();
      }

      if (url === '/api/json' && req.method === 'POST') {
        if (!client) return sendJson(res, 503, { code: 'unavailable', error: 'No Claude credentials on the server' });
        const input = validateJsonRequest(await readJson(req));
        try { return sendJson(res, 200, await askJson(client, input)); }
        catch (e) {
          if (e.code !== 'invalid_json') console.error('[json]', e.status || '', e.message);
          const status = e.code === 'refused' ? 422 : e.code === 'invalid_json' ? 502 : e.status === 429 ? 429 : 502;
          return sendJson(res, status, { code: e.code || errorCode(e), text: e.code === 'invalid_json' ? e.text.slice(0, 4000) : undefined });
        }
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
      const file = resolveStatic(appDir, url);
      if (!file) return sendJson(res, 400, { error: 'bad path' });
      fs.stat(file, (err, st) => {
        if (err || !st.isFile()) return sendJson(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': st.size,
          'cache-control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600' });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(file).pipe(res);
      });
    } catch (e) {
      if (e instanceof InputError) return sendJson(res, 400, { code: 'invalid_request', error: e.message });
      console.error('[server]', e);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); else res.end();
    }
  });
}

// The SDK builds a client without credentials and only fails on the first call, so check up front.
export function hasCredentials(env = process.env, home = process.env.HOME || '') {
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE) return true;
  if (env.ANTHROPIC_FEDERATION_RULE_ID && (env.ANTHROPIC_IDENTITY_TOKEN || env.ANTHROPIC_IDENTITY_TOKEN_FILE)) return true;
  return !!home && fs.existsSync(path.join(home, '.config', 'anthropic')); // `ant auth login` profile
}

async function main() {
  let client = null, mode = 'off';
  if (process.env.BOARD_FAKE === '1') { client = fakeClient(); mode = 'fake'; }
  else if (hasCredentials()) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic(); mode = 'live';
  } else {
    console.warn('No Claude credentials found; the page will run its scripted demo. Set ANTHROPIC_API_KEY (or run `ant auth login`) to go live.');
  }
  const port = Number(process.env.PORT || 8080);
  createServer({ client, mode }).listen(port, () => console.log(`Boardroom Live on http://localhost:${port} (${mode}, model ${MODEL})`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
