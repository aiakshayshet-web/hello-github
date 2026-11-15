/* Roast mode for Boardroom Live: the Roast Room council protocol run by the three board advisors.
 *
 * Flow: brief -> Round 1 openings -> Chair's cruxes -> Round 2 debate -> draft resolution
 *       -> Round 3 vote -> scored verdict.
 * Every seat scores every option 0-10; the Chair computes weighted option scores, a verdict band,
 * spread, confidence and overrides here, in code, so the numbers never come from the model.
 * The advisors are the board's own fictional characters; no real person is simulated.
 *
 * Pure functions only (no DOM, no network), exposed as window.RoastRoom, so they can be tested.
 */
(function (root) {
  'use strict';

  const SEAT_ORDER = ['elena', 'marcus', 'devon'];
  const SEATS = {
    elena: { name: 'Elena', pillar: 'Growth & marketing', dimension: 'Demand and distribution',
      question: 'Will people want this badly enough to pay, and where does the attention come from?',
      persona: 'Energetic and ambitious. Thinks in customer stories, positioning and word of mouth. Impatient with ideas nobody has asked for.' },
    marcus: { name: 'Marcus', pillar: 'Technology & architecture', dimension: 'Feasibility and technical risk',
      question: 'Can it be built simply and safely, and what breaks first?',
      persona: 'Dry and precise. Names concrete tools, latency, privacy and GDPR, build versus buy. Sceptical of over-engineering and of anything that cannot be tested cheaply.' },
    devon: { name: 'Devon', pillar: 'Operations & money', dimension: 'Execution, cash and downside',
      question: 'What does it cost in cash and founder time, and what is the worst case?',
      persona: 'Pragmatic. Brings rough numbers and dates in GBP, UK compliance, unit economics. Guards the downside: never risk ruin. Brokers compromises.' },
  };
  const LABELS = ['DON\'T DO IT', 'RESHAPE', 'GO WITH CONDITIONS', 'GO'];
  const STANCES = ['Strong yes', 'Yes', 'Conditional yes', 'No', 'Strong no'];
  const VOTES = ['Endorse', 'Endorse with amendment', 'Dissent'];

  /* ---------- normalising model output ---------- */
  const str = (v, max = 600) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
  const list = (v, n, max) => (Array.isArray(v) ? v.map(x => str(x, max)).filter(Boolean).slice(0, n) : []);
  function clampInt(v, lo, hi, def) { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; }
  function oneOf(v, allowed, def) { const s = str(v, 40).toLowerCase(); return allowed.find(a => a.toLowerCase() === s) || def; }
  function capWords(text, n) { const w = str(text, 2000).split(' ').filter(Boolean); return w.length > n ? w.slice(0, n).join(' ').replace(/[,;:]?$/, '…') : w.join(' '); }

  const STATUS_QUO_RE = /\b(don'?t|do not|keep (doing|things)|status quo|stay (as|the)|not at all|no change|walk away|hold off)\b/i;

  function normalizeBrief(b, topic) {
    b = b && typeof b === 'object' ? b : {};
    let options = Array.isArray(b.options) ? b.options : [];
    options = options.map(o => (typeof o === 'string' ? { label: o } : o || {}))
      .map(o => ({ label: str(o.label, 90), statusQuo: !!o.statusQuo || STATUS_QUO_RE.test(String(o.label || '')) }))
      .filter(o => o.label).slice(0, 4);
    if (!options.some(o => o.statusQuo)) {
      if (options.length >= 4) options.pop();
      options.push({ label: "Don't do it: keep things as they are", statusQuo: true });
    }
    if (options.length < 2) options.unshift({ label: str(topic, 90) || 'Go ahead as proposed', statusQuo: false });
    options = options.map((o, i) => ({ id: 'ABCD'[i], ...o }));
    const weights = {};
    SEAT_ORDER.forEach(k => {
      const w = b.weights && b.weights[k];
      weights[k] = { weight: clampInt(w && (w.weight ?? w), 1, 3, 2), reason: str(w && w.reason, 120) || SEATS[k].pillar };
    });
    // Roast Room rule: exactly one or two seats carry the most weight.
    const threes = SEAT_ORDER.filter(k => weights[k].weight === 3);
    if (threes.length === 3) weights.marcus.weight = 2;
    if (!threes.length) { const top = SEAT_ORDER.reduce((a, k) => (weights[k].weight > weights[a].weight ? k : a), 'devon'); weights[top].weight = 3; }
    return {
      decision: str(b.decision, 200) || str(topic, 200),
      options, weights,
      business: str(b.business, 300), resources: str(b.resources, 300), success: str(b.success, 300), lean: str(b.lean, 300),
      assumptions: list(b.assumptions, 6, 160),
      missing: list(b.missing, 3, 160),
    };
  }

  function normScores(s, optionIds) {
    const out = {};
    optionIds.forEach(id => { const v = s && s[id]; out[id] = v === undefined || v === null || v === '' ? null : clampInt(v, 0, 10, null); });
    return out;
  }

  function normalizeCard(round, c, optionIds) {
    c = c && typeof c === 'object' ? c : {};
    const base = { scores: normScores(c.scores, optionIds), pillarScore: clampInt(c.pillarScore, 0, 10, null),
      spoken: capWords(c.spoken, round === 3 ? 40 : 60) };
    if (round === 1) return { ...base, stance: oneOf(c.stance, STANCES, 'Conditional yes'), call: str(c.call, 240),
      confidence: clampInt(c.confidence, 1, 5, 3), ruinRisk: oneOf(c.ruinRisk, ['none', 'possible', 'likely'], 'none'),
      door: oneOf(c.door, ['one-way', 'two-way'], 'two-way'), why: list(c.why, 3, 260), risk: str(c.risk, 240),
      changeMind: str(c.changeMind, 240), thisWeek: str(c.thisWeek, 200), question: str(c.question, 200) };
    if (round === 2) return { ...base, stance: oneOf(c.stance, STANCES, 'Conditional yes'),
      confidence: clampInt(c.confidence, 1, 5, 3), ruinRisk: oneOf(c.ruinRisk, ['none', 'possible', 'likely'], 'none'),
      disagreeWith: oneOf(c.disagreeWith, SEAT_ORDER, ''), rebuttal: str(c.rebuttal, 300), concede: str(c.concede, 300),
      moved: str(c.moved, 200) || 'no', conditions: list(c.conditions, 3, 200) };
    return { ...base, vote: oneOf(c.vote, VOTES, 'Endorse'), finalScore: clampInt(c.finalScore, 0, 10, null),
      amendment: str(c.amendment, 300), oneLine: str(c.oneLine, 240) };
  }

  /* ---------- scoring (Roast Room scoring.md) ---------- */
  const round1 = x => Math.round(x * 10) / 10;

  function optionScores(cards, weights, optionIds) {
    const scores = {}, math = {};
    optionIds.forEach(id => {
      let num = 0, den = 0; const parts = [];
      SEAT_ORDER.forEach(k => {
        const c = cards[k], v = c && c.scores ? c.scores[id] : null;
        if (v === null || v === undefined) return;
        const w = weights[k].weight; num += w * v; den += w; parts.push(`${w}x${v}`);
      });
      scores[id] = den ? round1(num / den) : null;
      math[id] = den ? `${id} (${parts.join(' + ')}) / ${den} = ${scores[id].toFixed(1)}` : `${id} no scores`;
    });
    return { scores, math };
  }

  function band(score) {
    if (score === null || score === undefined) return 'RESHAPE';
    if (score >= 7.5) return 'GO';
    if (score >= 6) return 'GO WITH CONDITIONS';
    if (score >= 4.5) return 'RESHAPE';
    return "DON'T DO IT";
  }
  const capLabel = (label, max) => (LABELS.indexOf(label) > LABELS.indexOf(max) ? max : label);

  function topOption(card, optionIds) {
    let best = null;
    optionIds.forEach(id => { const v = card && card.scores ? card.scores[id] : null; if (v !== null && v !== undefined && (best === null || v > card.scores[best])) best = id; });
    return best;
  }

  function unanimous(cards, optionIds) {
    const tops = SEAT_ORDER.map(k => topOption(cards[k], optionIds));
    if (tops.some(t => !t) || new Set(tops).size !== 1) return false;
    const vals = SEAT_ORDER.map(k => cards[k].scores[tops[0]]);
    return Math.max(...vals) - Math.min(...vals) <= 1;
  }

  // R = {brief, rounds: {1:{seat:card}, 2:{...}, 3:{...}}}
  function computeVerdict(R) {
    const { brief } = R, ids = brief.options.map(o => o.id), W = brief.weights;
    const last = R.rounds[3] && Object.keys(R.rounds[3]).length ? R.rounds[3] : R.rounds[2];
    const { scores, math } = optionScores(last, W, ids);
    let recommended = null;
    ids.forEach(id => { if (scores[id] !== null && (recommended === null || scores[id] > scores[recommended])) recommended = id; });
    const rec = brief.options.find(o => o.id === recommended) || null;
    const overrides = [];
    let label = band(recommended ? scores[recommended] : null);
    if (rec && rec.statusQuo) { label = "DON'T DO IT"; overrides.push('"Don\'t do it" scored highest, so the verdict is DON\'T DO IT.'); }

    const seatVals = SEAT_ORDER.map(k => last[k] && last[k].scores ? last[k].scores[recommended] : null).filter(v => v !== null && v !== undefined);
    const spread = seatVals.length ? Math.max(...seatVals) - Math.min(...seatVals) : 0;

    // Ruin cap: a seat at "likely" ruin risk on the option it backs, when that is the recommended option.
    const r2 = R.rounds[2] || {};
    const ruinSeats = SEAT_ORDER.filter(k => r2[k] && r2[k].ruinRisk === 'likely' && topOption(r2[k], ids) === recommended);
    if (ruinSeats.length && !(rec && rec.statusQuo)) {
      const before = label; label = capLabel(label, 'RESHAPE');
      if (label !== before) overrides.push(`Ruin cap: ${ruinSeats.map(k => SEATS[k].name).join(' and ')} rated ruin risk "likely", so the verdict is capped at RESHAPE until a mitigation they endorse is in place.`);
    }
    // One-way door cap: most seats called it one-way in Round 1 and the spread is 4 or more.
    const r1 = R.rounds[1] || {};
    const oneWay = SEAT_ORDER.filter(k => r1[k] && r1[k].door === 'one-way').length;
    if (oneWay >= 2 && spread >= 4 && !(rec && rec.statusQuo)) {
      const before = label; label = capLabel(label, 'GO WITH CONDITIONS');
      if (label !== before) overrides.push('One-way door cap: most seats see this as hard to reverse and they disagree by 4+ points, so the cheapest test must come first.');
    }

    const confs = SEAT_ORDER.map(k => r2[k] && r2[k].confidence).filter(Number.isFinite);
    const confidence = Math.min(10, Math.max(1, Math.round((confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 3) * 2) - (spread >= 5 ? 1 : 0)));

    const r3 = R.rounds[3] || {};
    let sNum = 0, sDen = 0;
    SEAT_ORDER.forEach(k => { const f = r3[k] && r3[k].finalScore; if (Number.isFinite(f)) { sNum += W[k].weight * f; sDen += W[k].weight; } });
    const support = sDen ? round1(sNum / sDen) : null;
    const votes = { endorse: 0, amend: 0, dissent: 0 };
    SEAT_ORDER.forEach(k => { const v = r3[k] && r3[k].vote; if (v === 'Endorse') votes.endorse++; else if (v === 'Endorse with amendment') votes.amend++; else if (v === 'Dissent') votes.dissent++; });

    return { scores, math, recommended, recommendedLabel: rec ? rec.label : '', label, spread, confidence, support, votes, overrides };
  }

  /* ---------- prompts ---------- */
  const RULES = `You are part of Roast mode in Boardroom Live: an advisory board of three fictional advisors (Elena, Marcus, Devon) stress-tests one founder decision in a structured council. A Chair runs the room and never argues a side.
Write in plain British English. Money in GBP, given as rough estimates. Never invent facts about the founder; label assumptions. Advisors push back hard, disagree with each other by name, and never simply agree with the founder.
Reply with only one JSON object, no prose and no code fences.`;

  function briefText(brief) {
    const opts = brief.options.map(o => `${o.id}. ${o.label}`).join('\n');
    const w = SEAT_ORDER.map(k => `${SEATS[k].name} (${SEATS[k].pillar}): weight ${brief.weights[k].weight}/3, ${brief.weights[k].reason}`).join('\n');
    return `DECISION: ${brief.decision}
OPTIONS:
${opts}
BUSINESS: ${brief.business || 'not stated'}
RESOURCES: ${brief.resources || 'not stated'}
SUCCESS LOOKS LIKE: ${brief.success || 'not stated'}
FOUNDER'S LEAN: ${brief.lean || 'not stated'} (test the lean, do not echo it)
ASSUMPTIONS: ${brief.assumptions.join('; ') || 'none'}
SEAT WEIGHTS:
${w}`;
  }

  function cardsText(R, round) {
    const cards = R.rounds[round] || {};
    return SEAT_ORDER.filter(k => cards[k]).map(k => `${SEATS[k].name.toUpperCase()} (round ${round}): ${JSON.stringify(cards[k])}`).join('\n');
  }

  const notesText = R => (R.notes && R.notes.length ? `\nTHE FOUNDER ADDED DURING THE MEETING:\n${R.notes.map(n => '- ' + n).join('\n')}\n` : '');

  function briefPrompt(topic, extra) {
    return `${RULES}

You are the Chair. Turn what the founder said into the council brief.

FOUNDER SAID:
${topic}
${extra ? `\nFOUNDER'S ANSWERS TO YOUR QUESTIONS:\n${extra}\n` : ''}
Rules:
- The decision in one line, and 2 to 4 options. Always include "Don't do it" (or "keep doing what you do now") as an option and mark it statusQuo true. If the founder brought a single idea, add the obvious smaller version as another option.
- Set a weight for each seat from 1 to 3: 3 means the decision lives in that seat's area, 2 materially affected, 1 touched at the edges. Exactly one or two seats get 3.
  Elena: ${SEATS.elena.pillar}. Marcus: ${SEATS.marcus.pillar}. Devon: ${SEATS.devon.pillar}.
- "missing": up to 3 short questions for facts the council cannot do without (the business and its revenue, cash or runway and founder hours, what success looks like). Leave it empty if the founder already gave them${extra ? ' (they have now answered, so leave it empty and mark the rest as assumptions)' : ''}.
- Fill gaps with assumptions you state.

JSON shape:
{"decision":"","options":[{"label":"","statusQuo":false}],"business":"","resources":"","success":"","lean":"","assumptions":[""],"missing":[""],"weights":{"elena":{"weight":2,"reason":""},"marcus":{"weight":2,"reason":""},"devon":{"weight":2,"reason":""}}}`;
  }

  function seatHeader(seat, brief) {
    const s = SEATS[seat];
    return `${RULES}

You are ${s.name}, the ${s.pillar} seat. ${s.persona}
The question you own: ${s.question}
Your weight on this decision: ${brief.weights[seat].weight}/3 (${brief.weights[seat].reason}).

THE BRIEF
${briefText(brief)}`;
  }

  const SCORES_SHAPE = brief => `{${brief.options.map(o => `"${o.id}":0`).join(',')}}`;

  function seatPrompt(round, seat, R) {
    const { brief } = R, s = SEATS[seat];
    if (round === 1) return `${seatHeader(seat, brief)}
${notesText(R)}
ROUND 1 OF 3: OPENING POSITION. Argue from your own area first, at full strength; the Chair balances the room, not you. Use the brief's numbers and say which ones you are assuming.
- scores: how strongly you back each option, 0 to 10. pillarScore: the option you recommend, judged on ${s.dimension.toLowerCase()} alone.
- ruinRisk: an irreversible downside that could sink the company or the founder, for the option you recommend. door: how reversible that option is.
- spoken: what you say out loud on the call, 2 to 3 sentences, at most 55 words, plain speech, your verdict and the main reason, in your own voice.

JSON shape:
{"stance":"Strong yes|Yes|Conditional yes|No|Strong no","call":"one sentence naming the option","scores":${SCORES_SHAPE(brief)},"pillarScore":0,"confidence":3,"ruinRisk":"none|possible|likely","door":"one-way|two-way","why":["","",""],"risk":"","changeMind":"a concrete fact or number","thisWeek":"one action","question":"one question for the founder","spoken":""}`;

    if (round === 2) return `${seatHeader(seat, brief)}
${notesText(R)}
ROUND 1 CARDS
${cardsText(R, 1)}

THE CRUXES THE CHAIR SEES
${(R.cruxes && R.cruxes.cruxes || []).map((c, i) => `${i + 1}. ${c.question} (${(c.sides || []).map(x => `${x.position}: ${(x.seats || []).join(', ')}`).join(' vs ')})`).join('\n') || 'None named.'}
${R.cruxes && R.cruxes.unanimous ? '\nThe room agreed too quickly in Round 1. Argue the strongest alternative at full strength before you hold your position.\n' : ''}
ROUND 2 OF 3: DEBATE. Engage the other advisors' actual arguments. Move only for a better argument, never to be agreeable. If everyone agrees with you, attack the weakest part of your own case.
- disagreeWith: elena, marcus or devon (not yourself). rebuttal: their argument in one line, then your answer.
- concede: the strongest point made against you and what it changes.
- moved: "no", or "yes, from X to Y, because ...".
- conditions: up to 3 concrete, checkable conditions for a yes (a number, a date, a test result).
- spoken: what you say out loud, at most 55 words. Address the advisor you disagree with by name.

JSON shape:
{"disagreeWith":"","rebuttal":"","concede":"","stance":"Strong yes|Yes|Conditional yes|No|Strong no","scores":${SCORES_SHAPE(brief)},"pillarScore":0,"confidence":3,"ruinRisk":"none|possible|likely","moved":"no","conditions":[""],"spoken":""}`;

    const mine = R.rounds[2] && R.rounds[2][seat];
    return `${seatHeader(seat, brief)}
${notesText(R)}
YOUR ROUND 2 CARD
${JSON.stringify(mine || {})}

THE DRAFT RESOLUTION
${JSON.stringify(R.draft || {})}

ROUND 3 OF 3: VOTE ON THE DRAFT RESOLUTION.
- scores: each option given the resolution's conditions, 0 to 10. finalScore: your support for the resolution as written, 0 to 10.
- amendment: one or two sentences, or empty if you endorse as written.
- oneLine: the one thing from your area the founder must not forget.
- spoken: your vote out loud, at most 35 words.

JSON shape:
{"vote":"Endorse|Endorse with amendment|Dissent","scores":${SCORES_SHAPE(brief)},"finalScore":0,"pillarScore":0,"amendment":"","oneLine":"","spoken":""}`;
  }

  function cruxPrompt(R) {
    return `${RULES}

You are the Chair. Read the Round 1 cards and name what the advisors are really fighting about.

THE BRIEF
${briefText(R.brief)}
${notesText(R)}
ROUND 1 CARDS
${cardsText(R, 1)}
${R.unanimous ? '\nAll three backed the same option within one point. Treat that as a warning: make the strongest unargued alternative a crux.\n' : ''}
- cruxes: 1 to 3 underlying disagreements (a fact, a number or a value such as speed versus safety), each with the advisors on each side.
- spoken: what you say out loud to open Round 2, at most 50 words. You never argue a side.

JSON shape:
{"cruxes":[{"question":"","sides":[{"position":"","seats":["Elena"]}]}],"note":"one plain sentence","spoken":""}`;
  }

  function draftPrompt(R, interim) {
    return `${RULES}

You are the Chair. Write the draft resolution the council will vote on.

THE BRIEF
${briefText(R.brief)}
${notesText(R)}
ROUND 2 CARDS
${cardsText(R, 2)}

INTERIM WEIGHTED OPTION SCORES (computed): ${R.brief.options.map(o => `${o.id} ${interim.scores[o.id] ?? '-'}`).join(', ')}. The leading option is ${interim.recommended}.

Weigh arguments, not headcount: one advisor with a decisive fact beats two with opinions. Merge duplicate conditions and keep each checkable. When advisors give different numbers, pick one and say whose.

JSON shape:
{"option":"${interim.recommended}","recommendation":"one or two sentences","conditions":[""],"nextSteps":["step with a date"],"cheapestTest":"","killCriteria":"","spoken":"what you say out loud, at most 55 words"}`;
  }

  function verdictPrompt(R, V) {
    return `${RULES}

You are the Chair. The vote is in. Write the verdict for the founder. The label and numbers are already computed; do not change them.

THE BRIEF
${briefText(R.brief)}
${notesText(R)}
ROUND 2 CARDS
${cardsText(R, 2)}
ROUND 3 VOTES
${cardsText(R, 3)}
DRAFT RESOLUTION
${JSON.stringify(R.draft || {})}

COMPUTED: verdict ${V.label}; recommended option ${V.recommended} (${V.recommendedLabel}); option scores ${Object.entries(V.scores).map(([k, v]) => `${k} ${v}`).join(', ')}; spread ${V.spread}; confidence ${V.confidence}/10; support ${V.support ?? '-'}/10.
${V.overrides.length ? 'OVERRIDES: ' + V.overrides.join(' ') : ''}

- why: the 3 arguments that carried the room, each with the advisor who made it.
- fights: one line per crux on how it resolved.
- minority: the strongest dissent or minority view, and what would have to be true for it to be right.
- spoken: the verdict out loud, at most 70 words: the call, the main reason, and the first next step.

JSON shape:
{"call":"one or two sentences the founder can act on, naming the option","why":[{"point":"","seat":"Elena"}],"fights":[""],"minority":{"seat":"","view":"","wouldHaveToBeTrue":""},"conditions":[""],"nextSteps":[""],"cheapestTest":"","killCriteria":"","revisit":"","spoken":""}`;
  }

  function normalizeChair(kind, c) {
    c = c && typeof c === 'object' ? c : {};
    if (kind === 'cruxes') return { cruxes: (Array.isArray(c.cruxes) ? c.cruxes : []).slice(0, 3).map(x => ({ question: str(x && x.question, 160),
      sides: (Array.isArray(x && x.sides) ? x.sides : []).slice(0, 3).map(s => ({ position: str(s && s.position, 90), seats: list(s && s.seats, 3, 20) })) })).filter(x => x.question),
      note: str(c.note, 200), spoken: capWords(c.spoken, 60) };
    if (kind === 'draft') return { option: str(c.option, 2), recommendation: str(c.recommendation, 400), conditions: list(c.conditions, 8, 220),
      nextSteps: list(c.nextSteps, 5, 220), cheapestTest: str(c.cheapestTest, 300), killCriteria: str(c.killCriteria, 300), spoken: capWords(c.spoken, 60) };
    return { call: str(c.call, 400), why: (Array.isArray(c.why) ? c.why : []).slice(0, 5).map(w => ({ point: str(w && (w.point || w), 260), seat: str(w && w.seat, 20) })).filter(w => w.point),
      fights: list(c.fights, 3, 260), minority: { seat: str(c.minority && c.minority.seat, 20), view: str(c.minority && c.minority.view, 300), wouldHaveToBeTrue: str(c.minority && c.minority.wouldHaveToBeTrue, 260) },
      conditions: list(c.conditions, 8, 220), nextSteps: list(c.nextSteps, 3, 220), cheapestTest: str(c.cheapestTest, 300), killCriteria: str(c.killCriteria, 300),
      revisit: str(c.revisit, 200), spoken: capWords(c.spoken, 80) };
  }

  /* ---------- report ---------- */
  function verdictMarkdown(R, V, text) {
    const b = R.brief, ids = b.options.map(o => o.id), last = R.rounds[3] || {};
    const row = k => { const c = last[k] || {}, r2 = (R.rounds[2] || {})[k] || {};
      return `| ${SEATS[k].name} (${SEATS[k].pillar.toLowerCase()}) | ${b.weights[k].weight} | ${c.vote || '-'} | ${ids.map(id => (c.scores && c.scores[id] !== null && c.scores[id] !== undefined ? c.scores[id] : '-')).join(' | ')} | ${c.pillarScore ?? '-'} | ${r2.moved || '-'} | ${(c.oneLine || '').replace(/\|/g, '/')} |`; };
    const lines = [
      `# Roast: ${b.decision}`, '',
      `## Verdict: ${V.label}`, '',
      `**The call:** ${text.call || `Option ${V.recommended}: ${V.recommendedLabel}`}`, '',
      `Option scores: ${ids.map(id => `${id} ${V.scores[id] ?? '-'}`).join(' · ')} · Support ${V.support ?? '-'}/10 · Confidence ${V.confidence}/10 · Spread ${V.spread} · Vote: ${V.votes.endorse} endorse, ${V.votes.amend} amend, ${V.votes.dissent} dissent`,
      ...(V.overrides.length ? ['', ...V.overrides.map(o => `> ${o}`)] : []), '',
      '## Options', ...b.options.map(o => `- **${o.id}.** ${o.label}`), '',
      '## Scorecard', '',
      `| Seat | Weight | Vote | ${ids.join(' | ')} | Pillar | Moved? | Their line |`,
      `|---|---|---|${ids.map(() => '---').join('|')}|---|---|---|`,
      ...SEAT_ORDER.map(row), '',
      'Math:', ...ids.map(id => `- ${V.math[id]}`), '',
    ];
    if (text.why && text.why.length) lines.push('## Why the council landed here', ...text.why.map(w => `- ${w.point}${w.seat ? ` (${w.seat})` : ''}`), '');
    if (text.fights && text.fights.length) lines.push('## Where they fought', ...text.fights.map(f => `- ${f}`), '');
    if (text.minority && text.minority.view) lines.push('## Minority report', `${text.minority.seat ? `**${text.minority.seat}:** ` : ''}${text.minority.view}`, ...(text.minority.wouldHaveToBeTrue ? ['', `What would have to be true: ${text.minority.wouldHaveToBeTrue}`] : []), '');
    const conds = text.conditions && text.conditions.length ? text.conditions : (R.draft && R.draft.conditions) || [];
    if (conds.length) lines.push('## Conditions', ...conds.map(c => `- ${c}`), '');
    if (text.nextSteps && text.nextSteps.length) lines.push('## What to do next', ...text.nextSteps.map((s, i) => `${i + 1}. ${s}`), '');
    if (text.cheapestTest) lines.push(`**Cheapest test:** ${text.cheapestTest}`);
    if (text.killCriteria) lines.push(`**Kill criteria:** ${text.killCriteria}`);
    if (text.revisit) lines.push(`**Revisit:** ${text.revisit}`);
    lines.push('', '---', 'Elena, Marcus and Devon are fictional AI advisors. This is a structured second opinion, not professional advice.');
    return lines.join('\n');
  }

  root.RoastRoom = { SEAT_ORDER, SEATS, LABELS, normalizeBrief, normalizeCard, normalizeChair, optionScores, band, topOption, unanimous,
    computeVerdict, briefPrompt, seatPrompt, cruxPrompt, draftPrompt, verdictPrompt, verdictMarkdown, capWords };
})(typeof window !== 'undefined' ? window : globalThis);
