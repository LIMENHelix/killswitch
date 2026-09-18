// Shared Lob send + the K6 postcard channel adapter. Every prospect postcard
// goes through the K6 control plane (lib/k6-outreach.js): eligibility, durable
// effect reservation, atomic caps, and a stable provider idempotency key all
// happen BEFORE anything here is invoked.
import { frontHtml, backHtml } from './postcard.js';
import { getSite, upsertSite } from './sites.js';
import { externalSideEffectsAllowed } from './environment.js';
import { getSuppressionState, matchSuppression } from './suppression.js';

export const COST = 0.94;                 // approx per 6x9 postcard, USD
export const POSTCARD_COST_CENTS = Math.round(COST * 100);
// NOTE: POSTCARD_COST_CENTS is only the adapter's spend ESTIMATE recorded on
// accepted effects. It is NOT cap authority: K6 cap reservations use the
// owner-configured postcardReserveCents (lib/k6-outreach.js), and this repo
// carries no live Lob price anywhere.
const LOB_TIMEOUT_MS = 15000;             // a provider call never hangs unbounded

/**
 * Lob credential mode for the operator readiness view. Prefix classification
 * ONLY — the key itself is never returned, logged, or displayed. A set key
 * with an unrecognized prefix is UNRECOGNIZED, which the run path treats as
 * unusable for live sends (fail closed).
 */
export function lobKeyMode() {
  const k = String(process.env.LOB_API_KEY || '');
  if (!k) return 'MISSING';
  if (k.startsWith('test_')) return 'TEST';
  if (k.startsWith('live_')) return 'LIVE';
  return 'UNRECOGNIZED';
}

/** Presence-only check of the postcard return-address fields. Booleans, never values. */
export function senderConfigPresence() {
  return {
    KS_FROM_NAME: !!process.env.KS_FROM_NAME,
    KS_FROM_LINE1: !!process.env.KS_FROM_LINE1,
    KS_FROM_CITY: !!process.env.KS_FROM_CITY,
    KS_FROM_STATE: !!process.env.KS_FROM_STATE,
    KS_FROM_ZIP: !!process.env.KS_FROM_ZIP,
  };
}

export function hasAddr(l) { return !!(l.street && l.state && l.zip); }
export function isMailed(l) { return l.status === 'mailed' || !!l.lob_id; }
// budgetCeiling is a LIFETIME postage ceiling, so what has already been mailed
// (by autopilot or by hand) counts against it. One place computes it.
export function spentToDate(leads) { return +((leads.filter(isMailed).length) * COST).toFixed(2); }
export function isBad(l) { return l.status === 'bad_address'; }
export function inQueue(l) { return hasAddr(l) && !isMailed(l) && !isBad(l) && !l.suppressed; }

/**
 * A postcard that prints a URL must find a live page at it, so publishing the
 * draft is part of putting the card in the mail. It goes live UNCLAIMED, which
 * means noindex: the owner can open the link we sent them, and Google never
 * indexes a page branded with a business that has not agreed to anything.
 * Fails soft: no draft, or any error, and the card falls back to the plain offer.
 */
async function publishForMail(lead) {
  if (!lead.siteSlug) return '';
  try {
    const s = await getSite(lead.siteSlug);
    if (!s) return '';
    if (!s.published) await upsertSite({ slug: s.slug, published: true });
    return 'killswitchwebsites.com/s/' + s.slug;
  } catch (e) { console.error('[mailer] publish for mail', lead.siteSlug, e); return ''; }
}

export async function lobSend(lead, suppressionState, opts = {}) {
  const state = suppressionState || await getSuppressionState();
  const suppression = matchSuppression(lead, state);
  if (suppression) return { error: 'contact suppressed', code: 'suppressed', suppressionId: suppression.id };
  if (!externalSideEffectsAllowed()) return { error: 'preview side effects disabled' };
  const key = process.env.LOB_API_KEY;
  if (!key) return { error: 'LOB_API_KEY not set' };
  const siteUrl = opts.siteUrl !== undefined
    ? opts.siteUrl
    : (opts.publishForMail !== false) ? await publishForMail(lead) : '';
  const card = { ...lead, siteUrl };
  const frm = {
    name: process.env.KS_FROM_NAME, line1: process.env.KS_FROM_LINE1,
    city: process.env.KS_FROM_CITY, state: process.env.KS_FROM_STATE, zip: process.env.KS_FROM_ZIP,
  };
  if (!frm.name || !frm.line1 || !frm.zip) return { error: 'return address (KS_FROM_*) not set in Vercel' };
  const form = new URLSearchParams({
    description: `KS free-site postcard: ${lead.name}`,
    use_type: 'marketing',
    'to[name]': String(lead.name || '').slice(0, 40),
    'to[address_line1]': lead.street || '', 'to[address_city]': lead.city || '',
    'to[address_state]': lead.state || '', 'to[address_zip]': lead.zip || '',
    'from[name]': frm.name, 'from[address_line1]': frm.line1,
    'from[address_city]': frm.city, 'from[address_state]': frm.state, 'from[address_zip]': frm.zip,
    front: frontHtml(card), back: backHtml(card), size: '6x9',
  });
  const auth = Buffer.from(key + ':').toString('base64');
  const headers = { Authorization: 'Basic ' + auth, 'content-type': 'application/x-www-form-urlencoded' };
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  const r = await fetch('https://api.lob.com/v1/postcards', {
    method: 'POST',
    headers,
    body: form.toString(),
    signal: AbortSignal.timeout(Math.max(1000, Math.floor(Number(opts.timeoutMs) || LOB_TIMEOUT_MS))),
  });
  const j = await r.json().catch(() => ({}));
  if (r.ok && j.id) return { id: j.id };
  return { error: (j.error && j.error.message) || ('HTTP ' + r.status), code: j.error && j.error.code, status: r.status };
}

/**
 * K6 channel adapter for postcard sends via Lob.
 *
 * Conforms to the channelAdapter contract used by lib/k6-outreach.js:
 *   ({ lead, effect, cfg, idempotencyKey, attempt }) -> { ok, providerRef, reason, retryable, unknown, spend }
 *
 * DESTINATION POLICY (owner decision): this adapter never publishes. A lead
 * whose siteSlug resolves to a PUBLISHED site gets the delivery card naming
 * that live URL. Any other lead — no site, an unpublished draft, a missing
 * record — gets the plain-offer /start card, which is true for every
 * recipient. An unpublished destination is not a send failure.
 *
 * When the run's preflight already resolved the destination it arrives as
 * lead.resolvedSiteUrl (a string, possibly '') and is used as-is — no second
 * store lookup inside the provider attempt.
 */
export async function sendPostcard({ lead, effect, cfg, idempotencyKey, attempt }) {
  const normalizedLead = { ...lead, name: lead.name || lead.business || '' };
  let siteUrl;
  if (typeof normalizedLead.resolvedSiteUrl === 'string') {
    siteUrl = normalizedLead.resolvedSiteUrl;
  } else {
    siteUrl = '';
    if (normalizedLead.siteSlug) {
      let site = null;
      try { site = await getSite(normalizedLead.siteSlug); }
      catch (e) {
        return { ok: false, providerRef: '', reason: 'destination_lookup_failed', retryable: true, unknown: false, spend: 0 };
      }
      if (site && site.published) siteUrl = 'killswitchwebsites.com/s/' + site.slug;
    }
  }
  try {
    const result = await lobSend(normalizedLead, undefined, { idempotencyKey, siteUrl });
    if (result.id) {
      return { ok: true, providerRef: result.id, retryable: false, unknown: false, spend: POSTCARD_COST_CENTS };
    }
    if (result.code === 'suppressed') {
      return { ok: false, providerRef: '', reason: 'suppressed', retryable: false, unknown: false, spend: 0 };
    }
    if (result.code === 'failed_deliverability_strictness') {
      return { ok: false, providerRef: '', reason: 'bad_address', retryable: false, unknown: false, spend: 0 };
    }
    const msg = String(result.error || result.code || 'unknown');
    const configError = msg.includes('LOB_API_KEY')
      || msg.includes('return address')
      || msg.includes('side effects disabled');
    if (configError) {
      return { ok: false, providerRef: '', reason: msg, retryable: false, unknown: false, spend: 0 };
    }
    const transient = /5\d\d|rate|timeout|network|fetch failed|ECONN|ETIMED/i.test(msg)
      || result.status >= 500;
    return { ok: false, providerRef: '', reason: msg, retryable: transient, unknown: transient, spend: 0 };
  } catch (e) {
    // A timeout or connection failure is NOT "nothing happened": the provider
    // may have accepted the card. Classify it unknown so the effect keeps its
    // reservation and retries only through the same idempotency key.
    const isTimeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return {
      ok: false, providerRef: '',
      reason: isTimeout ? 'provider_timeout' : String(e && e.message || e).slice(0, 200),
      retryable: true, unknown: true, spend: 0,
    };
  }
}
