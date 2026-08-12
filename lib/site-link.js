// THE JOIN BETWEEN AN ACCOUNT AND THE SITE IT PAYS FOR, AND THE ALARM WHEN IT IS MISSING.
//
// The gap this closes: an account and a site are joined by nothing but an email
// string in `ks:siteemail`. `syncModules()` looks that up, and when it finds
// nothing it returns null. Every one of its six callers ignored that. So a
// customer could pay, Stripe could charge the card, the webhook could fire, the
// switch could flip green in their panel, and NOTHING would render on any site,
// with no error anywhere. The money was real and the delivery was silent.
//
// Two things live here.
//
// 1. linkAccountToSite() runs at onboarding and actually makes the join, so the
//    common case stops depending on someone having typed the business name the
//    same way twice.
// 2. syncModulesLoud() / removeModulesLoud() wrap the plain versions and, when
//    the join is missing, tell the operator instead of returning null into the
//    dark.
//
// The plain functions in sites.js are UNCHANGED and still exported. This is a
// layer on top, not a replacement, so nothing that already works can break.
//
// Nothing here throws. It is called from the payment path, and a bookkeeping
// failure must never cost a sale.

import { cmd, parseHash } from './kv.js';
import { getSite, upsertSite, siteForEmail, slugify, syncModules, removeModules, existingSlugs } from './sites.js';
import { notifyOperator, labelPhases } from './notify.js';

const UNLINKED_KEY = 'ks:unlinked';
const seenKey = (email) => 'ks:unlinked:seen:' + email;
const QUIET_SECONDS = 86400; // one alert per customer per day, not one per request

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

/**
 * Slug candidates for a site the customer may already have.
 *
 * `site` is whatever was typed at signup, which in practice is sometimes a
 * business name and sometimes a domain. "Joe's Plumbing", "joesplumbing.com"
 * and "https://www.joesplumbing.com/" all have to reach the same slug, or the
 * join silently misses and we are back where we started.
 */
export function slugCandidates({ site, name, business } = {}) {
  const out = [];
  const push = (v) => {
    const s = slugify(v);
    if (s && !out.includes(s)) out.push(s);
  };
  for (const raw of [site, business, name]) {
    const v = String(raw == null ? '' : raw).trim();
    if (!v) continue;
    push(v);
    const bare = v.replace(/^[a-z]+:\/\//i, '').replace(/^www\./i, '').split(/[/?#]/)[0];
    push(bare);
    push(bare.replace(/\.[a-z]{2,24}$/i, '')); // drop the TLD: joesplumbing.com -> joesplumbing
  }
  return out;
}

/**
 * Join an account to its site record, at onboarding.
 *
 * Binding means writing the email onto the site record, because that write is
 * what populates `ks:siteemail`, which is the only thing siteForEmail() reads.
 *
 * WILL NOT STEAL A SITE. If a slug matches but that record already belongs to a
 * different email, this reports a conflict and changes nothing. Two businesses
 * with similar names is an ordinary thing; handing one customer another
 * customer's website is not.
 *
 * Creates nothing. A customer with no site record yet is a real state, and the
 * honest response is to say so, not to invent an empty page.
 *
 * @returns {Promise<{linked:boolean, slug:string|null, reason:string, live:boolean}>} never rejects
 */
export async function linkAccountToSite({ email, site, name, business } = {}) {
  const e = norm(email);
  if (!e) return { linked: false, slug: null, reason: 'no_email', live: false };

  try {
    const already = await siteForEmail(e);
    if (already) {
      await clearUnlinked(e);
      return { linked: true, slug: already.slug, reason: 'already_linked', live: !!already.published };
    }

    // `live` is carried out because the welcome email makes a claim about it.
    // published:false is a hard 404, so a joined-but-unpublished site is NOT a
    // website anyone can visit, and saying otherwise in writing is a lie we sent.
    const bind = async (slug, rec) => {
      const owner = norm(rec.email);
      if (owner && owner !== e) return { linked: false, slug, reason: 'owned_by_other', live: false };
      await upsertSite({ slug, email: e });
      await clearUnlinked(e);
      return { linked: true, slug, reason: owner ? 'already_linked' : 'bound', live: !!rec.published };
    };

    const cands = slugCandidates({ site, name, business });

    // Exact slug first, always. This is the cheap, unambiguous case.
    for (const slug of cands) {
      const rec = await getSite(slug);
      if (rec) return await bind(slug, rec);
    }

    // A DOMAIN HAS NO SPACES AND A BUSINESS NAME DOES. "Mesa Roofing" is stored
    // as mesa-roofing, and someone who typed mesaroofing.com produces
    // mesaroofing, so the exact pass above misses the one record it was looking
    // for. Collapsing the hyphens out of both sides catches it. One HGETALL of
    // the summary index, which is what listing sites already costs.
    const flat = (s) => String(s || '').replace(/-/g, '');
    const wanted = new Set(cands.map(flat).filter(Boolean));
    const hits = [...(await existingSlugs())].filter((slug) => wanted.has(flat(slug)));

    // Collapsing hyphens can make two different businesses look identical
    // ("Joe Splumbing" and "Joes Plumbing" both flatten to joesplumbing). When
    // it is not obvious, guessing is worse than stopping: hand it to a human.
    if (hits.length > 1) return { linked: false, slug: null, reason: 'ambiguous', live: false };
    if (hits.length === 1) {
      const rec = await getSite(hits[0]);
      if (rec) return await bind(hits[0], rec);
    }

    return { linked: false, slug: null, reason: 'no_site_record', live: false };
  } catch (err) {
    console.error('[site-link] link', err);
    return { linked: false, slug: null, reason: 'threw', live: false };
  }
}

/**
 * syncModules(), but a missing site is reported instead of swallowed.
 * @param {string} where which code path called it, so the alert names the moment
 * @returns {Promise<object|null>} the site record, or null exactly as before
 */
export async function syncModulesLoud(email, modules, where) {
  const rec = await syncModules(email, modules);
  if (rec) { await clearUnlinked(norm(email)); return rec; }
  await reportUnlinked({ email, phases: modules || [], where });
  return null;
}

/**
 * removeModules(), same treatment.
 *
 * Note removeModules() returns null for TWO different reasons: nothing to drop,
 * and no site found. Only the second is a fault, so an empty phase list is not
 * reported as one.
 */
export async function removeModulesLoud(email, phases, where) {
  const list = phases || [];
  if (!list.length) return null;
  const rec = await removeModules(email, list);
  if (rec) { await clearUnlinked(norm(email)); return rec; }
  await reportUnlinked({ email, phases: list, where, ending: true });
  return null;
}

/**
 * Record the gap and email the operator, at most once a day per customer.
 *
 * Rate limited because the alternative is a mail per page view: /panel calls
 * syncModules on load, so an unlinked customer refreshing their panel would
 * otherwise send a hundred identical emails and train you to ignore all of them.
 * The hash entry is written EVERY time regardless, so /master can show the real
 * count and the last occurrence.
 */
export async function reportUnlinked({ email, phases = [], where = '', ending = false }) {
  const e = norm(email);
  if (!e) return { alerted: false, reason: 'no_email' };
  const at = new Date().toISOString();

  let count = 1;
  try {
    const prevRaw = await cmd(['HGET', UNLINKED_KEY, e]);
    if (prevRaw) { try { count = (JSON.parse(prevRaw).count || 0) + 1; } catch { /* keep 1 */ } }
    await cmd(['HSET', UNLINKED_KEY, e, JSON.stringify({ at, where, phases, ending, count })]);
  } catch (err) { console.error('[site-link] record unlinked', err); }

  console.error('[site-link] PAID MODULE WITH NO SITE', e, where, JSON.stringify(phases));

  // SET NX EX: the first caller in the window wins and mails, the rest stay quiet.
  let first = false;
  try { first = (await cmd(['SET', seenKey(e), at, 'NX', 'EX', String(QUIET_SECONDS)])) === 'OK'; }
  catch (err) { console.error('[site-link] quiet gate', err); first = true; }
  if (!first) return { alerted: false, reason: 'already_alerted_today', count };

  const verb = ending ? 'should have ended' : 'is paid for';
  await notifyOperator({
    subject: `Paid module not delivered - ${e}`,
    heading: 'A module ' + verb + ' but no website is attached to it',
    lines: [
      `Customer: ${e}`,
      `Modules: ${labelPhases(phases) || '(none named)'}`,
      `Where: ${where || 'unknown'}`,
      'Their account has no site record joined to it, so this change rendered nowhere.',
      'Open Master Panel, find or create their site, and set its email to the address above.',
    ],
    url: 'https://killswitchwebsites.com/master', urlText: 'Open Master Panel',
  });
  return { alerted: true, count };
}

/** The customer is joined again, so stop counting them as broken. */
export async function clearUnlinked(email) {
  const e = norm(email);
  if (!e) return false;
  try { await cmd(['HDEL', UNLINKED_KEY, e]); await cmd(['DEL', seenKey(e)]); return true; }
  catch (err) { console.error('[site-link] clear', err); return false; }
}

/** Everyone currently paying for something that renders nowhere. For /master. */
export async function listUnlinked() {
  try {
    const h = parseHash(await cmd(['HGETALL', UNLINKED_KEY]));
    return Object.keys(h).map((email) => {
      let v = {};
      try { v = typeof h[email] === 'string' ? JSON.parse(h[email]) : (h[email] || {}); } catch { v = {}; }
      return { email, ...v };
    }).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  } catch (err) { console.error('[site-link] list', err); return []; }
}
