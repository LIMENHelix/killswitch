// Customer SITE records: the data half of the one-template system.
//
// The old way was one hand-built HTML file per customer, which is why nothing
// scaled: every customer was a build, and every module they bought was a manual
// fulfilment. Here a site is DATA, and the same template renders all of them.
//
// modules[] is the on/off state. api/switch.js writes it whenever a customer
// flips something, so rendering never has to call Stripe (fast, free, and it
// still works if Stripe is briefly down). Stripe stays the source of truth for
// BILLING; this is the source of truth for WHAT RENDERS.
//
// ONE KEY PER SITE. Everything used to live under a single `ks:sites` JSON blob,
// which meant rendering ANY customer's page read EVERY customer's record, and
// saving one rewrote all of them. At a handful of customers that is invisible; at
// a few thousand drafts it is over a megabyte read on every cold page view, paid
// for by the byte, and any two saves in flight silently erase each other. So:
//
//   ks:site:<slug>   the full record, read and written on its own
//   ks:siteidx       hash slug -> small summary, for listing without reading all
//   ks:siteemail     hash email -> slug, so syncModules is one lookup not a scan
//
// Old blobs self-heal: a miss on the new key falls back to the legacy blob and
// writes the record forward, so nothing 404s during the change and no migration
// has to be remembered. migrateAll() does the whole set in one go.

import { cmd, pipeline, parseHash } from './kv.js';

const LEGACY_KEY = 'ks:sites';
const IDX_KEY = 'ks:siteidx';
const EMAIL_KEY = 'ks:siteemail';
const siteKey = (slug) => 'ks:site:' + slug;

export function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 60);
}

// Everything a site can hold. Missing fields simply do not render, so a
// half-filled record still produces a clean page rather than a broken one.
export const SITE_DEFAULT = {
  slug: '', email: '', business: '', trade: '', tagline: '',
  phone: '', email_public: '',
  street: '', city: '', state: '', zip: '',
  hours: [],            // [{ d:'Mon to Fri', h:'8am to 6pm' }]
  services: [],         // [{ name, desc }]
  about: '',
  accent: '#12703C',
  // WHICH OF THE FIVE LOOKS THEY PICKED. '' is the original palette, so
  // every record that already exists keeps rendering what it renders now.
  // Free, and deliberately not a module: see THEMES in lib/site-template.js.
  theme: '',
  // WHICH SHAPE the page takes. '' is the original layout every existing record
  // already renders, so adding layouts changes nobody until they pick one.
  // Free, like theme, and on the same axis-but-separate footing.
  layout: '',
  bookingUrl: '',       // P3
  payUrl: '',           // P7
  posts: [],            // [{ title, body, date }]  P2
  modules: ['P0'],      // what is switched ON
  // THREE STATES, not two. published:false is a hard 404 (invisible to everyone).
  // published:true, claimed:false is reachable by its URL but noindex, which is
  // what a postcard or a call needs: the owner can open the link we sent them,
  // and Google never indexes a page branded with a business that has agreed to
  // nothing. claimed:true is the customer saying yes, and only then is it
  // indexable. Same reasoning the six hand-built demos already carry.
  published: false,
  claimed: false,
  source: '',           // 'draft-bulk' when generated from a lead, '' when hand made
  leadId: '',           // the lead it was generated from, so the two can be joined
  // TWO SOURCES OF FACT, KEPT APART. Anything the owner said on the phone is
  // written straight onto the record above: it is their business, they are the
  // source of truth. Anything a web search turned up lands here instead and
  // waits for a human in /master, because a search result is a guess about a
  // business and the worst thing we can do is publish something untrue about it.
  proposed: {},         // { field: value } awaiting approval
  proposedNote: '',     // where it came from, in one line
  // A site written for THIS business by lib/site-writer.js. When present it is
  // what /s/<slug> serves. Empty means the shared template renders it instead,
  // so a business is never without a page while its own one is being written.
  htmlSrc: '',          // where that html was fetched from, so relative links can be re-rooted
  html: '',
  htmlAt: '',           // when it was generated
};

function summary(s) {
  return {
    business: s.business || '', email: s.email || '', trade: s.trade || '',
    city: s.city || '', published: !!s.published, claimed: !!s.claimed,
    modules: s.modules || ['P0'], source: s.source || '', leadId: s.leadId || '',
    hasProposed: !!(s.proposed && Object.keys(s.proposed).length),
    written: !!(s.html && s.html.length), htmlAt: s.htmlAt || '',
  };
}

// ---- legacy blob, read only, kept as a backstop until migrateAll has run ----
async function legacyBlob() {
  const v = await cmd(['GET', LEGACY_KEY]);
  if (!v) return null;
  try { return JSON.parse(v) || null; } catch { return null; }
}

// A record written before `claimed` existed was published BY HAND, one at a time,
// which is a person deciding to put it up. Treat that as claimed so nothing that
// is live today silently becomes noindex.
function fromLegacy(s) {
  const rec = { ...SITE_DEFAULT, ...s };
  if (s.claimed === undefined) rec.claimed = !!s.published;
  return rec;
}

/** One site, by slug. A single GET in the normal case. */
export async function getSite(slug) {
  const s = slugify(slug);
  if (!s) return null;
  const raw = await cmd(['GET', siteKey(s)]);
  if (raw) {
    try { return { ...SITE_DEFAULT, ...JSON.parse(raw) }; } catch { return null; }
  }
  // Miss. Might be a site written before the split, so look in the old blob and
  // carry it forward. Only ever costs anything on a miss, which is the 404 path.
  const blob = await legacyBlob();
  const hit = blob && blob[s];
  if (!hit) return null;
  const rec = { ...fromLegacy(hit), slug: s };
  await writeSite(rec);
  return rec;
}

async function writeSite(rec) {
  const cmds = [
    ['SET', siteKey(rec.slug), JSON.stringify(rec)],
    ['HSET', IDX_KEY, rec.slug, JSON.stringify(summary(rec))],
  ];
  const e = String(rec.email || '').trim().toLowerCase();
  if (e) cmds.push(['HSET', EMAIL_KEY, e, rec.slug]);
  await pipeline(cmds);
  return rec;
}

/** Summaries of every site, for the master list. One HGETALL, no site bodies. */
export async function listSites() {
  const idx = parseHash(await cmd(['HGETALL', IDX_KEY]));
  const out = Object.keys(idx).map((slug) => ({ slug, ...idx[slug] }));
  if (out.length) return out;
  // Index not built yet (first run after the split). Derive it from the old blob
  // without writing, so the list is never mysteriously empty.
  const blob = await legacyBlob();
  if (!blob) return [];
  return Object.values(blob).map((s) => ({ slug: s.slug, ...summary(fromLegacy(s)) }));
}

/** Back-compat for callers that want the full map. Avoid on hot paths. */
export async function getSites() {
  const list = await listSites();
  const out = {};
  for (const s of list) out[s.slug] = s;
  return out;
}

export async function upsertSite(site) {
  const slug = slugify(site && (site.slug || site.business));
  if (!slug) throw new Error('slug or business required');
  const existing = (await getSite(slug)) || { ...SITE_DEFAULT };
  // Spreading a key whose value is undefined still overwrites, so an incomplete
  // caller could erase a field it never meant to touch. Drop them: this is an
  // upsert, and a field you did not send is a field you did not change.
  const patch = {};
  for (const [k, v] of Object.entries(site || {})) if (v !== undefined) patch[k] = v;

  const prevEmail = String(existing.email || '').trim().toLowerCase();
  const rec = { ...SITE_DEFAULT, ...existing, ...patch, slug };
  await writeSite(rec);

  const nextEmail = String(rec.email || '').trim().toLowerCase();
  if (prevEmail && prevEmail !== nextEmail) await cmd(['HDEL', EMAIL_KEY, prevEmail]);
  return rec;
}

/** Write many records in as few round trips as possible. Bulk draft generation. */
export async function bulkUpsert(records) {
  const cmds = [];
  const saved = [];
  for (const r of records) {
    const slug = slugify(r.slug || r.business);
    if (!slug) continue;
    const rec = { ...SITE_DEFAULT, ...r, slug };
    saved.push(rec);
    cmds.push(['SET', siteKey(slug), JSON.stringify(rec)]);
    cmds.push(['HSET', IDX_KEY, slug, JSON.stringify(summary(rec))]);
    const e = String(rec.email || '').trim().toLowerCase();
    if (e) cmds.push(['HSET', EMAIL_KEY, e, slug]);
  }
  await pipeline(cmds);
  return saved;
}

/** Which slugs already exist, so bulk generation can avoid collisions. */
export async function existingSlugs() {
  const idx = parseHash(await cmd(['HGETALL', IDX_KEY]));
  return new Set(Object.keys(idx));
}

/**
 * The whole email -> slug join, in one read.
 *
 * siteForEmail() is one lookup per customer, which is right on a panel load and
 * wrong on a screen listing every account: that is a round trip each. This is
 * the same hash the join is actually stored in, so a list can show who is
 * attached without asking a hundred separate questions.
 */
export async function siteSlugsByEmail() {
  return parseHash(await cmd(['HGETALL', EMAIL_KEY]));
}

/** Find the site belonging to a customer email, so switch.js can sync modules. */
export async function siteForEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  const slug = await cmd(['HGET', EMAIL_KEY, e]);
  if (slug) return getSite(slug);
  // Not indexed yet: fall back to the old blob once, and index what we find.
  const blob = await legacyBlob();
  if (!blob) return null;
  const hit = Object.values(blob).find((s) => String(s.email || '').toLowerCase() === e);
  if (!hit) return null;
  const rec = fromLegacy(hit);
  await writeSite(rec);
  return rec;
}

/** Called by api/switch.js after a change so the live site matches what they pay for. */
export async function syncModules(email, modules) {
  const s = await siteForEmail(email);
  if (!s) return null;
  return upsertSite({ slug: s.slug, modules: Array.from(new Set(['P0', ...(modules || [])])) });
}

/**
 * Take specific modules OFF a site, leaving the rest alone.
 *
 * Used when a paid period finally runs out. Subtracting is safe here rather
 * than re-reading Stripe, because re-buying a module deletes its `ending`
 * entry, so anything still listed as ending genuinely has not been re-bought.
 */
export async function removeModules(email, phases) {
  const drop = new Set(phases || []);
  if (!drop.size) return null;
  const s = await siteForEmail(email);
  if (!s) return null;
  const kept = (s.modules || ['P0']).filter((p) => !drop.has(p));
  return upsertSite({ slug: s.slug, modules: Array.from(new Set(['P0', ...kept])) });
}

/**
 * Remove a site completely.
 *
 * THREE KEYS, NOT ONE. A record lives in its own key, a summary lives in the
 * list index, and the email join lives in a third hash. Deleting only the
 * record leaves the business still listed in /master and still resolving from
 * siteForEmail, so a customer's panel would keep syncing modules to a site that
 * no longer exists. All three go, in one round trip.
 *
 * Returns what was actually removed so a caller can tell "deleted" from "was
 * never there", which matters when someone asks you to prove a page is gone.
 */
export async function deleteSite(slug) {
  const s = slugify(slug);
  if (!s) return { deleted: false, reason: 'no_slug' };
  const rec = await getSite(s);
  if (!rec) return { deleted: false, reason: 'not_found' };

  const cmds = [['DEL', siteKey(s)], ['HDEL', IDX_KEY, s]];
  const e = String(rec.email || '').trim().toLowerCase();
  if (e) cmds.push(['HDEL', EMAIL_KEY, e]);
  await pipeline(cmds);
  return { deleted: true, slug: s, business: rec.business || '', email: e, wasPublished: !!rec.published };
}

/**
 * Move every record out of the legacy blob into its own key and build the index.
 * Safe to run more than once. The old blob is left in place as a backup.
 */
export async function migrateAll() {
  const blob = await legacyBlob();
  if (!blob) return { migrated: 0, alreadySplit: true };
  const recs = Object.values(blob).map((s) => ({ ...fromLegacy(s), slug: slugify(s.slug || s.business) }))
    .filter((s) => s.slug);
  await bulkUpsert(recs);
  return { migrated: recs.length, alreadySplit: false };
}

// Which modules actually change the WEBSITE. The rest are real products but they
// are back-office (CRM, automation, the sales agent), so they render nothing and
// pretending otherwise would be a lie on the page.
export const SITE_MODULES = {
  P1: 'Search listing',
  P2: 'Updates & posts',
  P3: 'Online booking',
  P7: 'Pay online',
  P8: 'Analytics',
  P9: '24/7 AI assistant',
};
export const BACKOFFICE_MODULES = { P4: 'Hosting', P5: 'CRM', P6: 'Automation', P10: 'AI sales agent', P11: 'Care plan' };

export function has(site, mod) {
  return Array.isArray(site.modules) && site.modules.includes(mod);
}
