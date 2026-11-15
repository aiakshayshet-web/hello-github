// The Roast-mode engine (app/roast.js): brief clean-up, card normalising, and the council's scoring rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(fileURLToPath(new URL('../../app/roast.js', import.meta.url)), 'utf8');
const ctx = { window: {} }; vm.runInNewContext(src, ctx);
const RR = ctx.window.RoastRoom;
const plain = v => JSON.parse(JSON.stringify(v)); // vm objects come from another realm

const card = (A, B, C, extra = {}) => ({ scores: { A, B, C }, ...extra });
const brief3 = (w = { elena: 3, marcus: 2, devon: 2 }) => RR.normalizeBrief({ decision: 'd', options: [{ label: 'Hauliers first' }, { label: 'Operators first' }, { label: "Don't do it", statusQuo: true }],
  weights: { elena: { weight: w.elena }, marcus: { weight: w.marcus }, devon: { weight: w.devon } } }, 'topic');

test('normalizeBrief always offers "don\'t do it", letters options and fixes weights', () => {
  const b = RR.normalizeBrief({ decision: 'Launch?', options: [{ label: 'Launch now' }, { label: 'Launch a smaller beta' }], weights: { elena: { weight: 9 }, marcus: { weight: 0 }, devon: {} } }, 'x');
  assert.deepEqual(plain(b.options.map(o => [o.id, o.statusQuo])), [['A', false], ['B', false], ['C', true]]);
  assert.equal(b.weights.elena.weight, 3); assert.equal(b.weights.marcus.weight, 1); assert.equal(b.weights.devon.weight, 2);
  const all3 = RR.normalizeBrief({ options: ['a', 'b'], weights: { elena: 3, marcus: 3, devon: 3 } }, 'x');
  assert.equal(['elena', 'marcus', 'devon'].filter(k => all3.weights[k].weight === 3).length, 2);
  const none3 = RR.normalizeBrief({ options: ['a', 'b'], weights: { elena: 1, marcus: 2, devon: 2 } }, 'x');
  assert.equal(['elena', 'marcus', 'devon'].filter(k => none3.weights[k].weight === 3).length, 1);
  const recognised = RR.normalizeBrief({ options: [{ label: 'Raise prices' }, { label: 'Keep doing what I do now' }] }, 'x');
  assert.equal(recognised.options.length, 2); assert.equal(recognised.options[1].statusQuo, true);
  assert.equal(RR.normalizeBrief(null, 'Should I hire?').options.length, 2);
});

test('normalizeCard clamps numbers, enums and spoken length', () => {
  const c = RR.normalizeCard(1, { scores: { A: 14, B: -3, C: '7' }, confidence: 9, ruinRisk: 'LIKELY', door: 'sideways', spoken: Array(90).fill('word').join(' ') }, ['A', 'B', 'C']);
  assert.deepEqual(plain(c.scores), { A: 10, B: 0, C: 7 });
  assert.equal(c.confidence, 5); assert.equal(c.ruinRisk, 'likely'); assert.equal(c.door, 'two-way');
  assert.ok(c.spoken.split(' ').length <= 60);
  const v = RR.normalizeCard(3, { vote: 'dissent', scores: { A: null } }, ['A', 'B']);
  assert.equal(v.vote, 'Dissent'); assert.equal(v.scores.A, null); assert.equal(v.scores.B, null);
});

test('optionScores is the weighted mean, skipping missing scores', () => {
  const W = brief3().weights;
  const { scores, math } = RR.optionScores({ elena: card(8, 4, 2), marcus: card(7, 4, 3), devon: card(7, null, 2) }, W, ['A', 'B', 'C']);
  assert.equal(scores.A, 7.4); // (3*8 + 2*7 + 2*7) / 7
  assert.equal(scores.B, 4);   // (3*4 + 2*4) / 5
  assert.match(math.A, /^A \(3x8 \+ 2x7 \+ 2x7\) \/ 7 = 7\.4$/);
});

test('verdict bands follow the Roast Room thresholds', () => {
  assert.equal(RR.band(7.5), 'GO'); assert.equal(RR.band(7.4), 'GO WITH CONDITIONS'); assert.equal(RR.band(6), 'GO WITH CONDITIONS');
  assert.equal(RR.band(5.9), 'RESHAPE'); assert.equal(RR.band(4.5), 'RESHAPE'); assert.equal(RR.band(4.4), "DON'T DO IT");
});

const rounds = (r3, r2 = {}, r1 = {}) => ({ 1: r1, 2: r2, 3: r3 });

test('computeVerdict picks the top option and reports spread, support and votes', () => {
  const brief = brief3();
  const r2 = { elena: card(8, 4, 2, { confidence: 4 }), marcus: card(7, 5, 3, { confidence: 3 }), devon: card(8, 3, 3, { confidence: 4 }) };
  const r3 = { elena: card(8, 4, 2, { vote: 'Endorse', finalScore: 8 }), marcus: card(7, 4, 3, { vote: 'Endorse with amendment', finalScore: 7 }), devon: card(8, 3, 3, { vote: 'Endorse', finalScore: 8 }) };
  const V = RR.computeVerdict({ brief, rounds: rounds(r3, r2) });
  assert.equal(V.recommended, 'A'); assert.equal(V.scores.A, 7.7); assert.equal(V.label, 'GO');
  assert.equal(V.spread, 1); assert.equal(V.confidence, 7); assert.equal(V.support, 7.7);
  assert.deepEqual(plain(V.votes), { endorse: 2, amend: 1, dissent: 0 });
  assert.equal(V.overrides.length, 0);
});

test('"don\'t do it" winning makes the verdict DON\'T DO IT', () => {
  const r3 = { elena: card(3, 2, 8), marcus: card(2, 3, 9), devon: card(4, 2, 8) };
  const V = RR.computeVerdict({ brief: brief3(), rounds: rounds(r3) });
  assert.equal(V.recommended, 'C'); assert.equal(V.label, "DON'T DO IT");
});

test('ruin cap: a seat at "likely" ruin on the recommended option caps the verdict at RESHAPE', () => {
  const r2 = { elena: card(9, 2, 1, { ruinRisk: 'likely', confidence: 4 }), marcus: card(8, 3, 2), devon: card(8, 2, 2) };
  const r3 = { elena: card(9, 2, 1), marcus: card(8, 3, 2), devon: card(8, 2, 2) };
  const V = RR.computeVerdict({ brief: brief3(), rounds: rounds(r3, r2) });
  assert.equal(RR.band(V.scores.A), 'GO'); assert.equal(V.label, 'RESHAPE');
  assert.match(V.overrides[0], /Ruin cap: Elena/);
});

test('one-way door cap: most seats say one-way and the spread is 4+', () => {
  const r1 = { elena: { door: 'one-way' }, marcus: { door: 'one-way' }, devon: { door: 'two-way' } };
  const r3 = { elena: card(10, 2, 1), marcus: card(10, 2, 1), devon: card(6, 2, 1) };
  const V = RR.computeVerdict({ brief: brief3(), rounds: rounds(r3, {}, r1) });
  assert.equal(V.spread, 4); assert.equal(RR.band(V.scores.A), 'GO'); assert.equal(V.label, 'GO WITH CONDITIONS');
  assert.match(V.overrides[0], /One-way door/);
});

test('unanimous flags a Round 1 where everyone backs the same option within a point', () => {
  assert.equal(RR.unanimous({ elena: card(8, 2, 1), marcus: card(8, 3, 1), devon: card(7, 2, 2) }, ['A', 'B', 'C']), true);
  assert.equal(RR.unanimous({ elena: card(8, 2, 1), marcus: card(6, 3, 1), devon: card(8, 2, 2) }, ['A', 'B', 'C']), false);
  assert.equal(RR.unanimous({ elena: card(8, 2, 1), marcus: card(2, 8, 1), devon: card(8, 2, 2) }, ['A', 'B', 'C']), false);
});

test('prompts carry the brief, the right round and the JSON shape', () => {
  const R = { brief: brief3(), rounds: { 1: { elena: card(8, 4, 2) } }, notes: ['I have £3k'], cruxes: { cruxes: [{ question: 'Who pays?', sides: [] }] } };
  const p1 = RR.seatPrompt(1, 'marcus', R);
  assert.match(p1, /You are Marcus, the Technology & architecture seat/);
  assert.match(p1, /ROUND 1 OF 3/); assert.match(p1, /"scores":\{"A":0,"B":0,"C":0\}/); assert.match(p1, /I have £3k/);
  assert.match(RR.seatPrompt(2, 'devon', R), /Who pays\?/);
  assert.match(RR.briefPrompt('Should I?', ''), /Don't do it/);
  assert.doesNotMatch(p1, /Bezos|Hormozi|Buffett|Musk/);
});

test('verdictMarkdown renders the call, scorecard, math and disclaimer', () => {
  const brief = brief3();
  const R = { brief, rounds: rounds({ elena: card(8, 4, 2, { vote: 'Endorse', oneLine: 'Charge | early' }), marcus: card(7, 4, 3), devon: card(8, 3, 3) }) };
  const V = RR.computeVerdict(R);
  const md = RR.verdictMarkdown(R, V, { call: 'Start with hauliers.', why: [{ point: 'Fast buyers', seat: 'Elena' }], nextSteps: ['Ten calls'], cheapestTest: 'By hand', killCriteria: 'Nobody pays' });
  assert.match(md, /^# Roast: d/); assert.match(md, /## Verdict: GO/); assert.match(md, /\*\*The call:\*\* Start with hauliers\./);
  assert.match(md, /\| Elena \(growth & marketing\) \| 3 \| Endorse \| 8 \| 4 \| 2 \|/); assert.match(md, /Charge \/ early/);
  assert.match(md, /- A \(3x8/); assert.match(md, /fictional AI advisors/);
});
