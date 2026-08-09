// Killswitch's own funnel, in L.A.S.E.R. stages, feeding lib/laser.js.
//
// The board used to record one flat outcome per lead: called, responded, won,
// dead. That is a list, not a funnel. `won` was a dead end with no appointment,
// no show, no deal size and no referral loop, so the ported engine had nothing to
// rank: allocate() reallocates volume across plays with observed wins and trials
// PER TRANSITION, and a single terminal flag gives it none of that.
//
// So each lead now carries a stage and, more importantly, a list of TOUCHES.
// A touch is one attempt at one transition through one channel, and whether it
// worked. That is exactly the unit laser.js scores.
//
// WHAT EACH STAGE MEANS HERE, because the words come from a different business:
//   lead        in the list, nobody has reached out
//   appointment they agreed to look ("yes, text me the link")
//   show        they actually opened their site        <- OBSERVED, see recordShow
//   enrollment  they took it. Free site = $0 deal.     <- OBSERVED, see recordEnrollment
//   referral    they sent us someone else
//   dead        out of the funnel, kept so we can learn what does not work
//
// Two of those record themselves. A hit on /s/<slug> is a show; onboarding is an
// enrollment. Nobody has to remember to click, which matters because the engine
// is only as honest as the events it is fed.

import { cmd, pipeline, parseHash } from './kv.js';

const KEY = 'ks:funnel';

export const STAGES = ['lead', 'appointment', 'show', 'enrollment', 'referral', 'dead'];

/** stage -> the transition that ENTERS it. Matches laser.js TRANSITIONS ids. */
export const ENTERS = {
  appointment: 'leads>appointments',
  show: 'appointments>shows',
  enrollment: 'shows>enrollments',
  referral: 'enrollments>referrals',
};

/** Channels we can actually use, and what one touch really costs us in cents. */
export const CHANNELS = {
  call: 0,        // the rep's time, not cash
  text: 4,
  email: 2,
  mailer: 94,     // Lob 6x9 postcard, the real number, not the engine's default 60
  social: 12,
  web: 0,         // they came to us
  other: 20,
};

// The old four-value vocabulary, so nothing recorded before this is lost.
const MIGRATE = {
  '': 'lead',
  called: 'lead',          // touched, but no commitment yet
  responded: 'appointment', // they engaged
  won: 'enrollment',        // they took the free site
  dead: 'dead',
};

export function migrateStage(old) {
  if (STAGES.includes(old)) return old;
  return MIGRATE[old || ''] || 'lead';
}

const now = () => new Date().toISOString();

/** One lead's funnel record. Missing is the same as untouched. */
function blank(id) {
  return { id, stage: 'lead', touches: [], apptAt: '', dealCents: 0, referredBy: '', updatedAt: '' };
}

export async function getFunnel() {
  return parseHash(await cmd(['HGETALL', KEY]));
}

export async function getOne(id) {
  const raw = await cmd(['HGET', KEY, String(id)]);
  if (!raw) return blank(id);
  try { return { ...blank(id), ...JSON.parse(raw) }; } catch { return blank(id); }
}

async function put(rec) {
  rec.updatedAt = now();
  await cmd(['HSET', KEY, String(rec.id), JSON.stringify(rec)]);
  return rec;
}

/**
 * Record one attempt at one transition. THIS is the unit the optimizer learns
 * from, so it is written even when it fails: a channel that never converts is
 * information, and dropping losses would quietly inflate every remaining rate.
 */
export async function recordTouch(id, { transition, channel, won, costCents, note }) {
  const rec = await getOne(id);
  rec.touches.push({
    ts: now(),
    transition,
    channel: channel in CHANNELS ? channel : 'other',
    won: !!won,
    costCents: Number.isFinite(costCents) ? costCents : (CHANNELS[channel] ?? 0),
    note: String(note || '').slice(0, 200),
  });
  if (rec.touches.length > 60) rec.touches = rec.touches.slice(-60);
  return put(rec);
}

/** Move a lead to a stage, recording the transition that got it there. */
export async function setStage(id, stage, { channel = 'other', dealCents, apptAt, note } = {}) {
  if (!STAGES.includes(stage)) throw new Error('unknown stage: ' + stage);
  const rec = await getOne(id);
  const transition = ENTERS[stage];
  if (transition) {
    rec.touches.push({
      ts: now(), transition, channel: channel in CHANNELS ? channel : 'other',
      won: true, costCents: CHANNELS[channel] ?? 0, note: String(note || '').slice(0, 200),
    });
  }
  rec.stage = stage;
  if (apptAt) rec.apptAt = String(apptAt).slice(0, 40);
  if (Number.isFinite(dealCents)) rec.dealCents = dealCents;
  return put(rec);
}

/**
 * They opened their site. Observed, not clicked: api/site.js calls this.
 * Only advances a lead that was waiting on it, so a customer refreshing their own
 * page for the hundredth time does not keep re-winning the same transition.
 */
export async function recordShow(id, channel = 'web') {
  const rec = await getOne(id);
  if (rec.stage !== 'lead' && rec.stage !== 'appointment') return rec;
  return setStage(id, 'show', { channel, note: 'opened their site' });
}

/** They took it. Free site is a real enrollment at a zero deal size. */
export async function recordEnrollment(id, dealCents = 0, channel = 'web') {
  const rec = await getOne(id);
  if (rec.stage === 'enrollment' || rec.stage === 'referral') return rec;
  return setStage(id, 'enrollment', { channel, dealCents, note: dealCents ? 'paid' : 'took the free site' });
}

/**
 * Turn every recorded touch into the play shape laser.js scores.
 * Deal size buckets keep the engine's segmentation meaningful: a free site and a
 * $99 Care Plan are not the same sale and should not share a play.
 */
export function dealBucket(cents) {
  if (!cents) return 'free';
  if (cents < 2500) return 'small';
  if (cents < 7500) return 'mid';
  return 'large';
}

export function toPlays(funnel) {
  const acc = {};
  for (const rec of Object.values(funnel || {})) {
    const bucket = dealBucket(rec.dealCents);
    for (const t of rec.touches || []) {
      const id = `${t.transition}|${t.channel}|${bucket}`;
      const p = acc[id] || (acc[id] = {
        id, transitionId: t.transition, unitLabel: 'channel', unit: t.channel,
        dealSize: bucket, trigger: 'none',
        segment: `${t.transition}|${bucket}|none`,
        trials: 0, wins: 0, costCents: 0,
      });
      p.trials++;
      if (t.won) p.wins++;
      p.costCents += t.costCents || 0;
    }
  }
  return Object.values(acc);
}

/** Stage counts and the conversion rate of each transition. */
export function summarize(funnel) {
  const byStage = {};
  for (const s of STAGES) byStage[s] = 0;
  let touches = 0, spendCents = 0;
  for (const rec of Object.values(funnel || {})) {
    byStage[rec.stage] = (byStage[rec.stage] || 0) + 1;
    for (const t of rec.touches || []) { touches++; spendCents += t.costCents || 0; }
  }
  const plays = toPlays(funnel);
  const rates = {};
  for (const p of plays) {
    const r = rates[p.transitionId] || (rates[p.transitionId] = { wins: 0, trials: 0 });
    r.wins += p.wins; r.trials += p.trials;
  }
  for (const k of Object.keys(rates)) {
    rates[k].rate = rates[k].trials ? rates[k].wins / rates[k].trials : 0;
  }
  return { byStage, touches, spendCents, rates, plays: plays.length };
}

/** Bulk-write migrated stages for leads that only have the old vocabulary. */
export async function migrateFrom(leadMeta) {
  const existing = await getFunnel();
  const cmds = [];
  let n = 0;
  for (const [id, m] of Object.entries(leadMeta || {})) {
    if (existing[id]) continue;                 // already has a funnel record
    const stage = migrateStage(m && m.stage);
    if (stage === 'lead') continue;             // nothing worth recording yet
    const rec = blank(id);
    rec.stage = stage;
    rec.updatedAt = now();
    // An old `won` really was an enrollment, so give the engine the transition
    // rather than a bare stage with no touch behind it.
    const transition = ENTERS[stage];
    if (transition) {
      rec.touches.push({ ts: rec.updatedAt, transition, channel: 'other', won: true, costCents: 0, note: 'migrated from the old board' });
    }
    cmds.push(['HSET', KEY, String(id), JSON.stringify(rec)]);
    n++;
  }
  if (cmds.length) await pipeline(cmds);
  return { migrated: n };
}
