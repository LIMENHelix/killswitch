// WHAT THE AI ACTUALLY COST, MEASURED RATHER THAN GUESSED.
//
// Every Anthropic response already carries a `usage` block with the real token
// counts, and every call site was throwing it away. That meant the only way to
// answer "what does a customer cost to run" was to reason from max_tokens caps
// and prompt lengths, which is an estimate wearing the clothes of a number. This
// keeps the counts, so margin per module becomes something you read instead of
// something you argue about.
//
// One hash per UTC day, so a day rolls over cleanly and old days expire on their
// own. Fields are per model, because the three models differ by 25x on output
// and an aggregate token count would hide exactly the thing worth seeing.
//
// FIRE AND FORGET. This is bookkeeping attached to a customer-facing reply. It
// never throws and it is never awaited in a way that can delay an answer.

import { cmd, pipeline, parseHash } from './kv.js';

const DAY_KEY = (d) => 'ks:ai:' + d;
const RETAIN_DAYS = 120;

/**
 * List price per MILLION tokens, from the Anthropic pricing table.
 *
 * Sonnet 5 carries introductory pricing that ENDS 2026-08-31. Hard-coding the
 * intro rate would silently understate cost from September onward, and hard-
 * coding the standard rate overstates it today, so the date is in the table and
 * the cost of a call is priced on the day it happened.
 */
export const PRICES = {
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 3, out: 15, intro: { in: 2, out: 10, until: '2026-08-31' } },
};

export function today(now = new Date()) { return now.toISOString().slice(0, 10); }

/** The rate in force for a model on a given day. */
export function rateFor(model, day = today()) {
  const p = PRICES[model];
  if (!p) return null;
  if (p.intro && day <= p.intro.until) return { in: p.intro.in, out: p.intro.out, intro: true };
  return { in: p.in, out: p.out, intro: false };
}

/** Dollars for one call. Returns null for a model with no price on file, which
 *  is honest: an unknown model has an unknown cost, not a zero one. */
export function costOf({ model, inTokens = 0, outTokens = 0, day = today() }) {
  const r = rateFor(model, day);
  if (!r) return null;
  return (inTokens / 1e6) * r.in + (outTokens / 1e6) * r.out;
}

/**
 * Record one Anthropic call.
 *
 * @param {object}  o
 * @param {string}  o.model  the model string that was actually sent
 * @param {object}  o.usage  the `usage` block off the response, as-is
 * @param {string}  o.where  which endpoint, so cost can be read per product
 * @returns {Promise<{recorded:boolean, cost?:number, reason?:string}>} never rejects
 */
export async function recordUsage({ model, usage, where = '' }) {
  try {
    const u = usage || {};
    // Cached reads are billed differently, but they are still input the model
    // saw. Counting them keeps the token totals true; the dollar figure below
    // therefore reads slightly HIGH on a cached call rather than low, which is
    // the safe direction for a number you make pricing decisions with.
    const inTok = Number(u.input_tokens || 0)
      + Number(u.cache_read_input_tokens || 0)
      + Number(u.cache_creation_input_tokens || 0);
    const outTok = Number(u.output_tokens || 0);
    if (!inTok && !outTok) return { recorded: false, reason: 'no_usage_block' };

    const day = today();
    const m = String(model || 'unknown');
    const cost = costOf({ model: m, inTokens: inTok, outTokens: outTok, day });

    console.log('[ai-usage]', JSON.stringify({ day, where, model: m, in: inTok, out: outTok, usd: cost == null ? null : Number(cost.toFixed(6)) }));

    // ONE ROUND TRIP, NOT FIVE. This runs between the model answering and the
    // customer seeing the answer, so five sequential Upstash calls would put
    // a fifth of a second of bookkeeping in front of every chat reply.
    const key = DAY_KEY(day);
    const cmds = [
      ['HINCRBY', key, m + ':in', String(inTok)],
      ['HINCRBY', key, m + ':out', String(outTok)],
      ['HINCRBY', key, m + ':calls', '1'],
    ];
    if (where) cmds.push(['HINCRBY', key, 'where:' + where + ':calls', '1']);
    cmds.push(['EXPIRE', key, String(RETAIN_DAYS * 86400)]);
    await pipeline(cmds);

    return { recorded: true, cost: cost == null ? undefined : cost };
  } catch (err) {
    console.error('[ai-usage] record', err);
    return { recorded: false, reason: 'threw' };
  }
}

/**
 * Read the last N days back, per model, with the dollars priced at the rate that
 * was in force on each day rather than today's rate.
 * @returns {Promise<{days:object[], totalUsd:number}>} never rejects
 */
export async function readUsage(days = 30, now = new Date()) {
  const out = [];
  let totalUsd = 0;
  try {
    for (let i = 0; i < days; i++) {
      const d = new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10);
      const h = parseHash(await cmd(['HGETALL', DAY_KEY(d)]));
      const fields = Object.keys(h);
      if (!fields.length) continue;

      const models = {};
      const byWhere = {};
      for (const f of fields) {
        const n = Number(h[f]) || 0;
        if (f.startsWith('where:')) { byWhere[f.slice(6).replace(/:calls$/, '')] = n; continue; }
        const cut = f.lastIndexOf(':');
        if (cut < 1) continue;
        const model = f.slice(0, cut), part = f.slice(cut + 1);
        models[model] = models[model] || { in: 0, out: 0, calls: 0 };
        if (part === 'in' || part === 'out' || part === 'calls') models[model][part] = n;
      }

      let usd = 0;
      for (const [model, v] of Object.entries(models)) {
        const c = costOf({ model, inTokens: v.in, outTokens: v.out, day: d });
        v.usd = c == null ? null : Number(c.toFixed(4));
        if (c != null) usd += c;
      }
      usd = Number(usd.toFixed(4));
      totalUsd += usd;
      out.push({ day: d, models, byWhere, usd });
    }
  } catch (err) { console.error('[ai-usage] read', err); }
  return { days: out, totalUsd: Number(totalUsd.toFixed(4)) };
}
