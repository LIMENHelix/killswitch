// Visitor counts for a customer site. This is the whole of P8 Analytics.
//
// P8 was sold at $19/mo for "a plain-English monthly report", "see what becomes
// a sale", "track your goals", "see where people click". What it actually did
// was inject Vercel's insights script, whose data lands in the OPERATOR's Vercel
// dashboard. The customer had no screen, no report, and no number. They were
// paying for telemetry about themselves that they could not see.
//
// So this counts views ourselves and shows them the number. It is a much smaller
// claim than the old bullet list, and unlike the bullet list it is true.
//
// WHY A BEACON AND NOT api/site.js. Serving a page is edge-cached for 60s
// (s-maxage in api/site.js), so counting there would miss every view that the
// cache served and quietly undercount a paying customer's traffic. A beacon
// fires per browser load. It costs one function invocation per view, which only
// happens for customers who are paying for P8, so the cost scales with revenue.
//
// Keys, all plain integers:
//   ks:v:<slug>            all time
//   ks:v:<slug>:<YYYY-MM>  that month
//   ks:v:<slug>:<YYYY-MM-DD>  that day, expired after 100 days
import { cmd, pipeline } from './kv.js';

const total = (slug) => 'ks:v:' + slug;
const month = (slug, ym) => 'ks:v:' + slug + ':' + ym;
const day = (slug, ymd) => 'ks:v:' + slug + ':' + ymd;

/** YYYY-MM-DD and YYYY-MM for a date, in UTC so a server move cannot shift a day. */
export function stamps(d = new Date()) {
  const ymd = d.toISOString().slice(0, 10);
  return { ymd, ym: ymd.slice(0, 7) };
}

/**
 * Count one view. Fire and forget at the call site: a counter must never be the
 * reason a customer's website fails to answer.
 */
export async function recordView(slug, now = new Date()) {
  const s = String(slug || '').trim();
  if (!s) return false;
  const { ymd, ym } = stamps(now);
  await pipeline([
    ['INCR', total(s)],
    ['INCR', month(s, ym)],
    ['INCR', day(s, ymd)],
    // Daily rows are only there to draw the last month. Letting them accumulate
    // forever would grow one key per site per day with nothing ever reading them.
    ['EXPIRE', day(s, ymd), String(100 * 24 * 60 * 60)],
  ]);
  return true;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * What the panel shows: all time, this month, last month, and the last 30 days
 * as a series so it can be drawn.
 */
export async function getStats(slug, now = new Date()) {
  const s = String(slug || '').trim();
  if (!s) return null;
  const { ym } = stamps(now);

  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const prevYm = stamps(prev).ym;

  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    days.push(stamps(d).ymd);
  }

  const res = await pipeline([
    ['GET', total(s)],
    ['GET', month(s, ym)],
    ['GET', month(s, prevYm)],
    ...days.map((ymd) => ['GET', day(s, ymd)]),
  ]);

  const series = days.map((ymd, i) => ({ date: ymd, views: num(res[3 + i]) }));
  return {
    allTime: num(res[0]),
    thisMonth: num(res[1]),
    lastMonth: num(res[2]),
    last30: series.reduce((a, b) => a + b.views, 0),
    series,
  };
}

/** Read one site's all-time count without the rest. Used by the master board. */
export async function viewsFor(slug) {
  return num(await cmd(['GET', total(String(slug || '').trim())]));
}
