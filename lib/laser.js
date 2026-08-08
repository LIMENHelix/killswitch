// LASER — Leads, Appointments, Shows, Enrollments, Referrals.
// The operator's name for the five-stage funnel, and his engine.
//
// PORTED VERBATIM from Limen-Helix-live-/lib/sales-engine.js on 2026-08-08.
// The only change is CommonJS -> ESM (one module.exports became xport).
// Nothing else was touched, because this file is pure: no requires, no fetch, no
// database, no env. It computes and nothing else, which is exactly why it moves
// cleanly and why its behaviour here should be identical to limenhelix.com's.
//
// It is a COPY, deliberately. Killswitch runs its own so limenhelix.com is never
// in its critical path. Reporting Killswitch's funnel events back upstream stays
// available as a one-way pipe later; it is not a dependency now.
//
// What it does: every play is a composable unit (stage-transition x channel/lever
// x FITT x SET/FBA script layering x deal size x emotional trigger). It tracks
// which compositions convert, ranks by Wilson lower bound so a 2-of-2 never
// outranks 40-of-50, and reallocates volume toward winners while keeping an
// exploration floor so losing plays are never starved to zero data.
/**
 * sales-engine.js — the revenue machine core (CommonJS, zero deps).
 *
 * The model, in one line: a LIQUID funnel where every "play" is a composable
 * unit — { stage-transition, channel/lever, FITT settings, script layering
 * (SET/FBA in any combination), target deal-size, target emotional trigger } —
 * and the machine tracks which compositions actually convert, then reallocates
 * volume toward the winners, SEGMENTED by deal size and trigger.
 *
 *   LASER = the engine (a lead is run through the 5-stage funnel).
 *   FITT / SET / FBA = composable TOOLS layered inside the engine.
 *   This file = the math (config, conversion, bandit scoring, allocation) plus
 *   a clearly-LABELED simulator so the machine is alive before real events flow.
 *
 * HONESTY GUARDRAILS
 *  - The optimizer learns ONLY from observed wins/trials. It never sees a play's
 *    hidden `latentRate` (that exists only inside the simulator).
 *  - Ranking uses the Wilson lower confidence bound, so a 2-of-2 play does NOT
 *    outrank a 40-of-50 play. Small-sample winners are held with tongs.
 *  - Nothing here contacts anyone, sends anything, or spends money. It computes.
 *    Simulated events carry `simulated:true` end to end.
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────
// CONFIG — the taxonomy. Config-driven: any vertical drops in by editing this.
// Costs are in CENTS (per attempt) and are DEFAULTS the operator can override.
// ─────────────────────────────────────────────────────────────────────────

// The five funnel buckets, in order. REFERRALS feeds back into LEADS.
const STAGES = ['leads', 'appointments', 'shows', 'enrollments', 'referrals'];

// The transitions the machine optimizes. `into:'leads'` is lead ACQUISITION
// (source -> a lead exists). Each transition names its unit-of-variation
// ("channel" for outreach, "lever" for closing skills) and the options for it.
const TRANSITIONS = [
  {
    id: 'source>leads', from: 'source', to: 'leads', unit: 'source',
    label: 'Acquisition',
    options: {
      'lead-gen-marketing': 900, 'b2b': 1200, 'b2c': 600,
      'mailers': 700, 'scraping': 120, 'social': 300, 'referral-loop': 40
    }
  },
  {
    id: 'leads>appointments', from: 'leads', to: 'appointments', unit: 'channel',
    label: 'Lead → Appointment',
    options: { call: 45, text: 4, email: 2, mailer: 60, social: 12, other: 20 }
  },
  {
    id: 'appointments>shows', from: 'appointments', to: 'shows', unit: 'channel',
    label: 'Appointment → Show',
    options: { 'confirm-email': 2, 'confirm-text': 4, 'confirm-call': 45, mailer: 60, other: 15 }
  },
  {
    id: 'shows>enrollments', from: 'shows', to: 'enrollments', unit: 'lever',
    label: 'Show → Enrollment (the close)',
    options: { closing: 0, urgency: 0, rapport: 0, presentation: 0, 'price-point': 0, volume: 0 }
  },
  {
    id: 'enrollments>referrals', from: 'enrollments', to: 'referrals', unit: 'channel',
    label: 'Enrollment → Referral',
    options: { text: 4, email: 2, call: 45, script: 0, other: 10 }
  }
];

// Segmentation axes — the machine keeps a SEPARATE optimum per (dealSize,trigger)
// because what closes a large deal on fear is not what closes a small one on
// convenience. That per-segment optimum is the moat.
const DEAL_SIZES = ['small', 'medium', 'large'];
const TRIGGERS = ['fear', 'gain', 'convenience', 'status', 'belonging', 'urgency', 'trust'];

// The composable tools.
const FITT = {
  frequency: ['1 touch', '3 touches / 10d', '7 touches / 14d', '12 touches / 21d'],
  intensity: ['low', 'medium', 'high', 'saturate'],   // intensity == quantity/aggressiveness
  time: ['early-am', 'midday', 'evening', 'weekend'],
  type: ['call', 'text', 'email', 'mailer', 'social', 'in-person']
};
const SET = ['state-fact', 'expose-need', 'tie-down'];          // State a fact, Expose a need, Tie down
const FBA = ['feature', 'benefit', 'advantage'];

function defaultConfig() {
  return {
    stages: STAGES,
    transitions: TRANSITIONS,
    dealSizes: DEAL_SIZES,
    triggers: TRIGGERS,
    fitt: FITT,
    set: SET,
    fba: FBA,
    // Revenue attributed to one enrollment, by deal size (cents). Drives ROI.
    dealValueCents: { small: 30000, medium: 120000, large: 500000 },
    updatedTs: null
  };
}

// ─────────────────────────────────────────────────────────────────────────
// PRNG — seedable so simulations are reproducible (and so this stays pure).
// ─────────────────────────────────────────────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// ─────────────────────────────────────────────────────────────────────────
// PLAY — a composition. `notation` renders the F(SET)·I(FBA)·… shorthand.
// ─────────────────────────────────────────────────────────────────────────
function segmentKey(p) { return p.transitionId + '|' + p.dealSize + '|' + p.trigger; }

function notation(layerMap) {
  // layerMap: { frequency:['SET'], intensity:['FBA'], time:['SET','FBA'], type:[] }
  const letter = { frequency: 'F', intensity: 'I', time: 'T', type: 'T' };
  return ['frequency', 'intensity', 'time', 'type'].map(function (dim) {
    const layers = (layerMap && layerMap[dim]) || [];
    return letter[dim] + (layers.length ? '(' + layers.join('+') + ')' : '');
  }).join('·');
}

function newPlay(fields) {
  const p = Object.assign({
    id: fields.id,
    transitionId: fields.transitionId,
    unitLabel: fields.unitLabel,       // "channel" | "lever" | "source"
    unit: fields.unit,                 // e.g. 'call', 'rapport', 'b2b'
    dealSize: fields.dealSize,
    trigger: fields.trigger,
    fitt: fields.fitt || {},           // { frequency, intensity, time, type }
    layerMap: fields.layerMap || {},   // which SET/FBA layers hang off each FITT dim
    copy: fields.copy || {},           // { fact, need, tie, feature, benefit, advantage }
    source: fields.source || 'template', // 'template' | 'ai'
    createdTs: fields.createdTs || null,
    // observed performance (what the optimizer sees):
    trials: 0, wins: 0, costCents: 0,
    // simulator-only hidden truth (optimizer NEVER reads this):
    latentRate: fields.latentRate == null ? null : fields.latentRate
  }, {});
  p.notation = notation(p.layerMap);
  p.segment = segmentKey(p);
  return p;
}

// ─────────────────────────────────────────────────────────────────────────
// SCORING — Wilson lower bound. Honest ranking under small samples.
// ─────────────────────────────────────────────────────────────────────────
function wilsonLower(wins, trials, z) {
  if (!trials || trials <= 0) return 0;
  z = z || 1.96;
  const p = wins / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const centre = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
  return Math.max(0, (centre - margin) / denom);
}

function scorePlay(p) {
  const rate = p.trials ? p.wins / p.trials : 0;
  const lower = wilsonLower(p.wins, p.trials);
  const costPerWin = p.wins ? p.costCents / p.wins : null;
  return { rate: rate, lower: lower, costPerWin: costPerWin, trials: p.trials, wins: p.wins };
}

/**
 * allocate — within each segment group, hand out a volume weight per play.
 * Proportional to Wilson-lower score, with an exploration floor so fresh or
 * losing plays still get sampled (never fully starved to zero data). This is
 * the "adjust and reallocate" behavior: winners get fed, losers get a trickle.
 */
function allocate(plays, opts) {
  opts = opts || {};
  const floor = opts.explore == null ? 0.08 : opts.explore; // min share per play
  const groups = {};
  plays.forEach(function (p) { (groups[p.segment] = groups[p.segment] || []).push(p); });
  const weights = {};
  Object.keys(groups).forEach(function (seg) {
    const g = groups[seg];
    const scores = g.map(function (p) { return wilsonLower(p.wins, p.trials) + 1e-6; });
    const total = scores.reduce(function (a, b) { return a + b; }, 0);
    g.forEach(function (p, i) {
      const raw = scores[i] / total;                      // exploit share
      const w = floor / g.length + (1 - floor) * raw;     // + exploration floor
      weights[p.id] = w;
    });
    // renormalize the group to sum to 1
    let s = 0; g.forEach(function (p) { s += weights[p.id]; });
    g.forEach(function (p) { weights[p.id] = weights[p.id] / s; });
  });
  return weights; // { playId: shareWithinSegment }
}

// ─────────────────────────────────────────────────────────────────────────
// FUNNEL AGGREGATION — the %/cost dashboard, computed from the running agg.
// agg shape: { 'from>to': { unit: { attempts, wins, costCents } } }
// ─────────────────────────────────────────────────────────────────────────
function emptyAgg() { return {}; }

function applyEvent(agg, ev) {
  const t = agg[ev.transitionId] || (agg[ev.transitionId] = {});
  const u = t[ev.unit] || (t[ev.unit] = { attempts: 0, wins: 0, costCents: 0 });
  u.attempts += 1;
  if (ev.won) u.wins += 1;
  u.costCents += ev.costCents || 0;
  // Revenue is booked on a WON enrollment, by deal size. We store the COUNT
  // per deal size (under a reserved key that never collides with a transition
  // id) and multiply by config.dealValueCents at read time — so re-pricing a
  // deal size reprices history without a migration.
  if (ev.won && ev.to === 'enrollments') {
    const e = agg.__enroll || (agg.__enroll = {});
    const ds = ev.dealSize || 'medium';
    e[ds] = (e[ds] || 0) + 1;
  }
  return agg;
}

function computeFunnel(agg, config) {
  config = config || defaultConfig();
  const out = { transitions: [], stageCounts: {}, feedbackLoop: null };
  // stage counts: count that REACHED a stage = wins of the transition into it
  const reached = { leads: 0, appointments: 0, shows: 0, enrollments: 0, referrals: 0 };
  config.transitions.forEach(function (def) {
    const t = agg[def.id] || {};
    let attempts = 0, wins = 0, cost = 0;
    const units = Object.keys(t).map(function (name) {
      const u = t[name];
      attempts += u.attempts; wins += u.wins; cost += u.costCents;
      return {
        name: name,
        attempts: u.attempts, wins: u.wins,
        conv: u.attempts ? u.wins / u.attempts : 0,
        costCents: u.costCents,
        costPerWinCents: u.wins ? u.costCents / u.wins : null
      };
    });
    // best converter + best bang-for-buck (lowest cost per win among those with wins)
    const withWins = units.filter(function (x) { return x.wins > 0; });
    const bestConv = units.slice().sort(function (a, b) { return b.conv - a.conv; })[0] || null;
    const bestValue = withWins.slice().sort(function (a, b) { return a.costPerWinCents - b.costPerWinCents; })[0] || null;
    if (def.to in reached) reached[def.to] = wins;
    out.transitions.push({
      id: def.id, from: def.from, to: def.to, label: def.label, unitLabel: def.unit,
      attempts: attempts, wins: wins, conv: attempts ? wins / attempts : 0,
      costCents: cost, costPerWinCents: wins ? cost / wins : null,
      units: units.sort(function (a, b) { return b.conv - a.conv; }),
      bestConverter: bestConv ? bestConv.name : null,
      bestValue: bestValue ? bestValue.name : null
    });
  });
  out.stageCounts = reached;
  // feedback loop strength: referrals produced vs leads acquired
  const refWins = reached.referrals;
  out.feedbackLoop = { referralsProduced: refWins, note: 'referrals re-enter the LEADS bucket' };
  // headline ROI: revenue from enrollments (by deal size) vs total spend
  let spend = 0;
  config.transitions.forEach(function (def) {
    const t = agg[def.id] || {};
    Object.keys(t).forEach(function (n) { spend += t[n].costCents; });
  });
  out.spendCents = spend;

  const dv = config.dealValueCents || {};
  const enroll = agg.__enroll || {};
  let revenue = 0;
  const byDeal = {};
  Object.keys(enroll).forEach(function (ds) {
    const cents = (enroll[ds] || 0) * (dv[ds] || 0);
    byDeal[ds] = { count: enroll[ds] || 0, valueCents: dv[ds] || 0, revenueCents: cents };
    revenue += cents;
  });
  out.revenueCents = revenue;
  out.revenueByDeal = byDeal;
  out.profitCents = revenue - spend;
  out.roas = spend > 0 ? revenue / spend : null;          // return on ad spend (x)
  out.costPerEnrollCents = reached.enrollments ? spend / reached.enrollments : null;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// PLAY GENERATION (template) — deterministic fallback when AI is off.
// Produces a spread of compositions for one segment so the machine has
// something to test immediately. AI generation (handler) enriches `copy`.
// ─────────────────────────────────────────────────────────────────────────

// Which triggers a given layering NATURALLY fits — used ONLY by the simulator
// to assign a hidden latent rate. This is the "truth" the optimizer rediscovers.
function latentFor(transitionId, unit, dealSize, trigger, layerMap, rng) {
  const base = {
    'source>leads': 0.12,
    'leads>appointments': 0.16,
    'appointments>shows': 0.62,
    'shows>enrollments': 0.30,
    'enrollments>referrals': 0.22
  }[transitionId] || 0.2;

  // layering depth
  const depth = Object.keys(layerMap || {}).reduce(function (a, d) { return a + (layerMap[d] || []).length; }, 0);

  // Coherent story the demo will surface:
  //  - LARGE deals reward rich layering (rapport + presentation + FBA/SET depth)
  //  - SMALL deals reward speed/frequency, punished by over-layering
  let fit = 1.0;
  if (dealSize === 'large') fit *= (0.75 + 0.10 * depth);
  else if (dealSize === 'small') fit *= (1.25 - 0.09 * depth);
  else fit *= (1.0 + 0.02 * depth);

  // trigger ↔ lever/channel affinity (a few sensible couplings)
  const affinity = {
    urgency: ['confirm-text', 'text', 'urgency', 'call'],
    fear: ['call', 'confirm-call', 'presentation', 'rapport'],
    trust: ['rapport', 'presentation', 'email', 'confirm-email'],
    convenience: ['text', 'confirm-text', 'email'],
    status: ['presentation', 'in-person', 'mailer'],
    gain: ['price-point', 'presentation', 'call'],
    belonging: ['rapport', 'social', 'referral-loop']
  }[trigger] || [];
  if (affinity.indexOf(unit) !== -1) fit *= 1.35;

  const noise = rng ? (0.85 + 0.3 * rng()) : 1;
  return clamp(base * fit * noise, 0.01, 0.95);
}

/**
 * generateTemplatePlays — build `count` varied plays for one segment
 * (transition × dealSize × trigger). Deterministic given seed.
 */
function generateTemplatePlays(transitionId, dealSize, trigger, count, seed, idPrefix) {
  const def = TRANSITIONS.filter(function (t) { return t.id === transitionId; })[0];
  if (!def) return [];
  const rng = mulberry32((seed || 1) >>> 0);
  const units = Object.keys(def.options);
  const layerChoices = [
    {}, { frequency: ['SET'] }, { type: ['FBA'] },
    { frequency: ['SET'], intensity: ['FBA'] },
    { frequency: ['SET'], time: ['SET'], type: ['FBA'] },
    { frequency: ['SET', 'FBA'], intensity: ['SET'], time: ['FBA'], type: ['SET', 'FBA'] }
  ];
  const plays = [];
  for (let i = 0; i < count; i++) {
    const unit = pick(rng, units);
    const layerMap = layerChoices[Math.floor(rng() * layerChoices.length)];
    const fitt = {
      frequency: pick(rng, FITT.frequency),
      intensity: pick(rng, FITT.intensity),
      time: pick(rng, FITT.time),
      type: pick(rng, FITT.type)
    };
    const id = (idPrefix || 'P') + '-' + transitionId.replace(/[^a-z]/gi, '') + '-' + dealSize[0] + trigger.slice(0, 3) + '-' + i + '-' + Math.floor(rng() * 1e6).toString(36);
    plays.push(newPlay({
      id: id, transitionId: transitionId, unitLabel: def.unit, unit: unit,
      dealSize: dealSize, trigger: trigger, fitt: fitt, layerMap: layerMap,
      copy: templateCopy(unit, dealSize, trigger, layerMap),
      source: 'template',
      latentRate: latentFor(transitionId, unit, dealSize, trigger, layerMap, rng)
    }));
  }
  return plays;
}

// Each FITT dimension is a SUBJECT you can sell on. On any dimension you can run a SET
// sequence (state a fact -> expose a need -> tie-down) and/or an FBA sequence (feature ->
// benefit -> advantage), in any order. The layerMap decides which sequences hang off which
// dimension; the copy is generated PER dimension so the pitch reads as the actual process.
const FITT_ANGLE = {
  frequency: { label: 'Frequency', subject: 'how often you reach out',
    fact: function (u, d, t) { return 'FACT: reaching a ' + d + ' prospect via ' + u + ' usually takes several touches, not one.'; },
    need: function (u, d, t) { return 'NEED: how many follow-ups are you actually making on ' + t + ' leads before you stop?'; },
    tie:  function (u, d, t) { return 'TIE-DOWN: so running ' + u + ' on a set cadence instead of one-and-done makes sense, agreed?'; },
    feature: function (u, d, t) { return 'FEATURE: a fixed multi-touch ' + u + ' cadence.'; },
    benefit: function (u, d, t) { return 'BENEFIT: fewer ' + t + ' prospects go cold between touches.'; },
    advantage: function (u, d, t) { return 'ADVANTAGE: vs one-and-done, cadence lifts the ' + d + '/' + t + ' segment.'; } },
  intensity: { label: 'Intensity', subject: 'how hard you push (quantity)',
    fact: function (u, d, t) { return 'FACT: a ' + d + ' deal rarely closes on a single soft ask.'; },
    need: function (u, d, t) { return 'NEED: how hard are you really pushing on your ' + t + ' opportunities right now?'; },
    tie:  function (u, d, t) { return 'TIE-DOWN: so matching intensity to the size of the deal makes sense, right?'; },
    feature: function (u, d, t) { return 'FEATURE: outreach intensity calibrated to deal size.'; },
    benefit: function (u, d, t) { return 'BENEFIT: you spend effort where the ' + d + ' money actually is.'; },
    advantage: function (u, d, t) { return 'ADVANTAGE: you stop over-working small deals and under-working big ones.'; } },
  time: { label: 'Time', subject: 'timing, time of day, and duration',
    fact: function (u, d, t) { return 'FACT: ' + t + ' prospects answer in specific windows, not at random.'; },
    need: function (u, d, t) { return 'NEED: when in the day are you sending these, and how long do you keep at it?'; },
    tie:  function (u, d, t) { return 'TIE-DOWN: so timing the touch to the window that works makes sense, agreed?'; },
    feature: function (u, d, t) { return 'FEATURE: window-timed outreach over a set period.'; },
    benefit: function (u, d, t) { return 'BENEFIT: higher answer and open rates for the same effort.'; },
    advantage: function (u, d, t) { return 'ADVANTAGE: same work, better hit rate than sending whenever.'; } },
  type: { label: 'Type', subject: 'which channel or type you use',
    fact: function (u, d, t) { return 'FACT: a ' + d + ' buyer favors certain channels over others.'; },
    need: function (u, d, t) { return 'NEED: which channel are you defaulting to for ' + t + ', and is it theirs or yours?'; },
    tie:  function (u, d, t) { return 'TIE-DOWN: so matching the channel to how the buyer responds makes sense, right?'; },
    feature: function (u, d, t) { return 'FEATURE: channel matched to the buyer (' + u + ').'; },
    benefit: function (u, d, t) { return 'BENEFIT: you meet them where they actually reply.'; },
    advantage: function (u, d, t) { return 'ADVANTAGE: vs one-size blasting, channel-fit converts the ' + t + ' segment.'; } }
};

// Build copy PER FITT dimension, only for the dimensions the layerMap uses. Each block carries
// the SET and/or FBA lines run ON that subject, and `layers` preserves the order to weave them.
function templateCopy(unit, dealSize, trigger, layerMap) {
  const out = {};
  ['frequency', 'intensity', 'time', 'type'].forEach(function (dim) {
    const layers = (layerMap && layerMap[dim]) || [];
    if (!layers.length) return;
    const A = FITT_ANGLE[dim];
    const block = { label: A.label, subject: A.subject, layers: layers.slice() };
    if (layers.indexOf('SET') > -1) { block.fact = A.fact(unit, dealSize, trigger); block.need = A.need(unit, dealSize, trigger); block.tie = A.tie(unit, dealSize, trigger); }
    if (layers.indexOf('FBA') > -1) { block.feature = A.feature(unit, dealSize, trigger); block.benefit = A.benefit(unit, dealSize, trigger); block.advantage = A.advantage(unit, dealSize, trigger); }
    out[dim] = block;
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// SIMULATOR — LABELED. Runs synthetic leads through the funnel using each
// play's HIDDEN latentRate; records observable events + updates play stats.
// The optimizer then learns from those stats without ever seeing latentRate.
// ─────────────────────────────────────────────────────────────────────────
function simulate(playsById, config, opts) {
  config = config || defaultConfig();
  opts = opts || {};
  const n = opts.n || 200;
  const rng = mulberry32((opts.seed || 12345) >>> 0);
  const plays = Object.keys(playsById).map(function (k) { return playsById[k]; });
  const weights = allocate(plays, { explore: 0.12 });
  const events = [];
  let leadsIn = 0, enrolled = 0, referred = 0, revenueCents = 0;

  // group plays by segment for quick weighted pick
  const bySeg = {};
  plays.forEach(function (p) { (bySeg[p.segment] = bySeg[p.segment] || []).push(p); });

  function weightedPick(list) {
    if (!list || !list.length) return null;
    let r = rng(), acc = 0;
    for (let i = 0; i < list.length; i++) { acc += weights[list[i].id] || (1 / list.length); if (r <= acc) return list[i]; }
    return list[list.length - 1];
  }
  function runTransition(transitionId, dealSize, trigger) {
    const seg = transitionId + '|' + dealSize + '|' + trigger;
    const play = weightedPick(bySeg[seg]);
    if (!play) return { won: false, play: null };
    const def = TRANSITIONS.filter(function (t) { return t.id === transitionId; })[0];
    const cost = def.options[play.unit] || 0;
    const won = rng() < (play.latentRate == null ? 0.2 : play.latentRate);
    play.trials += 1; play.costCents += cost; if (won) play.wins += 1;
    events.push({
      transitionId: transitionId, from: def.from, to: def.to, unit: play.unit,
      playId: play.id, dealSize: dealSize, trigger: trigger, won: won,
      costCents: cost, simulated: true
    });
    return { won: won, play: play };
  }

  for (let i = 0; i < n; i++) {
    const dealSize = pick(rng, config.dealSizes);
    const trigger = pick(rng, config.triggers);
    // acquisition
    const acq = runTransition('source>leads', dealSize, trigger);
    if (!acq.won) continue;
    leadsIn += 1;
    if (!runTransition('leads>appointments', dealSize, trigger).won) continue;
    if (!runTransition('appointments>shows', dealSize, trigger).won) continue;
    if (!runTransition('shows>enrollments', dealSize, trigger).won) continue;
    enrolled += 1;
    revenueCents += (config.dealValueCents && config.dealValueCents[dealSize]) || 0;
    if (runTransition('enrollments>referrals', dealSize, trigger).won) referred += 1;
  }

  return {
    events: events,
    summary: { n: n, leadsIn: leadsIn, enrolled: enrolled, referred: referred, revenueCents: revenueCents },
    plays: plays  // mutated in place with new trials/wins/costCents
  };
}

export {
  STAGES, TRANSITIONS, DEAL_SIZES, TRIGGERS, FITT, SET, FBA,
  defaultConfig, mulberry32,
  newPlay, notation, segmentKey,
  wilsonLower, scorePlay, allocate,
  emptyAgg, applyEvent, computeFunnel,
  latentFor, generateTemplatePlays, templateCopy, simulate,
  clamp
};
