// Rate limiting for the endpoints that spend real money.
//
// There was none anywhere, and four public routes reach a paid API:
//   /api/chat          Anthropic, completely unauthenticated
//   /api/site-action   Anthropic (ask) AND Resend (contact), unauthenticated
//   /api/support       Anthropic, panel-authenticated
//   /api/checkout      Stripe session creation, unauthenticated
//
// The contact form I added made this worse rather than better: one request now
// sends TWO emails, one to the business and one to the operator, so a loop on a
// published site is an unbounded Resend bill and a sender-reputation problem.
//
// A fixed window, not a sliding one. A sliding window needs a sorted set per
// caller and a trim on every request; a fixed window is one INCR and one EXPIRE.
// The edge case, twice the limit across a window boundary, does not matter when
// the goal is stopping a loop rather than exact fairness.
import { cmd, pipeline, configured } from './kv.js';

/**
 * Caller identity. Vercel puts the real client first in x-forwarded-for; the
 * rest of the chain is proxies and must be ignored, or anyone can prepend a
 * fake address and get a fresh bucket per request.
 */
export function callerIp(req) {
  const h = (req && req.headers) || {};
  const fwd = String(h['x-forwarded-for'] || h['X-Forwarded-For'] || '');
  const first = fwd.split(',')[0].trim();
  return first || String(h['x-real-ip'] || h['x-vercel-forwarded-for'] || 'unknown').trim() || 'unknown';
}

/**
 * Count one hit against a bucket.
 *
 * @param {string} bucket what is being limited, e.g. 'chat' or 'contact:my-shop'
 * @param {string} who    caller identity, usually an IP
 * @param {number} limit  hits allowed per window
 * @param {number} windowSec window length
 * @returns {Promise<{ok:boolean, count:number, limit:number, retryAfter:number, degraded:boolean}>}
 */
export async function hit(bucket, who, limit, windowSec) {
  // No KV configured (local dev, preview without env): allow, and say so, rather
  // than pretending a limit is in force.
  if (!configured()) return { ok: true, count: 0, limit, retryAfter: 0, degraded: true };

  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / windowSec);
  const key = `ks:rl:${bucket}:${who}:${window}`;

  try {
    const res = await pipeline([['INCR', key], ['EXPIRE', key, String(windowSec + 5)]]);
    const count = Number(res && res[0]) || 0;
    const resetAt = (window + 1) * windowSec;
    return { ok: count <= limit, count, limit, retryAfter: Math.max(1, resetAt - now), degraded: false };
  } catch (e) {
    console.error('[ratelimit] store unreachable', bucket, e && e.message);
    return { ok: true, count: 0, limit, retryAfter: 0, degraded: true };
  }
}

/**
 * Apply a limit and answer the caller if they are over it.
 *
 * FAIL OPEN OR CLOSED IS A PER-ENDPOINT JUDGEMENT, so it is a parameter rather
 * than a global. When the counter itself is unreachable:
 *   failClosed:false  a real customer enquiry still gets through. Correct for
 *                     the contact form, where losing a lead costs more than the
 *                     abuse it might let through.
 *   failClosed:true   refuse. Correct for the AI endpoints, where an unmetered
 *                     loop is pure cost with no upside if it is abuse.
 *
 * @returns {Promise<boolean>} true if the request was ANSWERED (caller should stop)
 */
export async function limited(req, res, { bucket, limit, windowSec, failClosed = false, message }) {
  const who = callerIp(req);
  const r = await hit(bucket, who, limit, windowSec);

  if (r.degraded && failClosed) {
    console.error('[ratelimit] failing closed, counter unreachable:', bucket);
    res.status(503).json({ error: 'unavailable', message: 'Please try again in a moment.' });
    return true;
  }
  if (!r.ok) {
    console.error('[ratelimit] blocked', bucket, who, r.count + '/' + r.limit);
    if (res.setHeader) res.setHeader('retry-after', String(r.retryAfter));
    res.status(429).json({
      error: 'rate_limited',
      retryAfter: r.retryAfter,
      message: message || 'That is a lot of requests. Please wait a moment and try again.',
    });
    return true;
  }
  return false;
}

// The limits, in one place so they can be read as a policy rather than hunted
// for. Each is set well above what a real person does and well below what a
// loop does in a second.
export const LIMITS = {
  // A visitor asking the marketing bot questions. Anthropic on every call.
  chat: { limit: 20, windowSec: 600, failClosed: true },
  // A visitor asking a customer's site assistant. Anthropic on every call.
  siteAsk: { limit: 20, windowSec: 600, failClosed: true },
  // A real person sends one message. Five an hour is generous.
  // FAIL OPEN: a lost enquiry is worse than a few extra emails.
  siteContact: { limit: 5, windowSec: 3600, failClosed: false },
  // Same reasoning: a booking request is a lead.
  siteBook: { limit: 5, windowSec: 3600, failClosed: false },
  // The P8 pageview beacon. Cheap, but should not be a write amplifier.
  siteView: { limit: 60, windowSec: 60, failClosed: false },
  // An existing customer talking to the support assistant. Anthropic.
  support: { limit: 40, windowSec: 600, failClosed: true },
  // Creating Stripe sessions is cheap but should not be spammable.
  checkout: { limit: 10, windowSec: 3600, failClosed: false },
};
