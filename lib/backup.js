// Daily backups and uptime monitoring. PURELY ADDITIVE: nothing that already
// runs is changed, these are two new jobs that read and report.
//
// P4 Hosting & Maintenance sells "daily backups" and "watched around the clock".
// Neither existed. Rather than strike the claims off the page, this is the code
// that makes them true.
//
// WHAT A BACKUP IS HERE. Customer sites are data, not files: one Redis key per
// site plus the account map. The risk is not a disk dying, Upstash handles that,
// it is a bad write or a bad delete taking a customer's content with it. So a
// backup is a dated SNAPSHOT of every site record, kept for 30 days, which is
// what lets one customer be put back the way they were on a given day.
import { cmd, pipeline, parseHash } from './kv.js';
import { getAccounts } from './store.js';

const IDX_KEY = 'ks:siteidx';
const siteKey = (slug) => 'ks:site:' + slug;
const snapKey = (stamp) => 'ks:backup:' + stamp;
const SNAP_INDEX = 'ks:backups';

const DAYS_KEPT = 30;

export function stamp(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * Snapshot every site record under one dated key.
 * Safe to run more than once a day: the same stamp overwrites itself, so a
 * retry produces one backup, not two.
 */
export async function runBackup(now = new Date()) {
  const idx = parseHash(await cmd(['HGETALL', IDX_KEY]));
  const slugs = Object.keys(idx);
  if (!slugs.length) return { stamp: stamp(now), sites: 0, bytes: 0, skipped: true };

  // Read in batches so one enormous pipeline does not have to hold everything.
  const records = {};
  const BATCH = 200;
  for (let i = 0; i < slugs.length; i += BATCH) {
    const chunk = slugs.slice(i, i + BATCH);
    const raw = await pipeline(chunk.map((s) => ['GET', siteKey(s)]));
    chunk.forEach((s, j) => { if (raw[j]) records[s] = raw[j]; });
  }

  // READ THE LIVE ACCOUNTS, NOT THE OLD BLOB. This used to GET 'ks:accounts'
  // directly. Accounts are one hash field each now, and that blob is a frozen
  // backstop that is never written again, so reading it here would have quietly
  // backed up a snapshot from the day of the split, for ever, while reporting
  // success. A backup that captures stale data is worse than no backup, because
  // you only find out on the day you need it.
  const accounts = await getAccounts();
  const body = JSON.stringify({ at: now.toISOString(), sites: records, accounts });
  const s = stamp(now);

  await pipeline([
    ['SET', snapKey(s), body],
    // Expire slightly past the retention window so the index and the data do
    // not disagree at the boundary.
    ['EXPIRE', snapKey(s), String((DAYS_KEPT + 2) * 24 * 60 * 60)],
    ['HSET', SNAP_INDEX, s, JSON.stringify({ at: now.toISOString(), sites: slugs.length, bytes: body.length })],
  ]);

  await prune(now);
  return { stamp: s, sites: slugs.length, bytes: body.length };
}

/** Drop index entries older than the retention window. */
export async function prune(now = new Date()) {
  const idx = parseHash(await cmd(['HGETALL', SNAP_INDEX]));
  const cutoff = new Date(now.getTime() - DAYS_KEPT * 86400000).toISOString().slice(0, 10);
  const stale = Object.keys(idx).filter((k) => k < cutoff);
  if (!stale.length) return 0;
  await pipeline(stale.map((k) => ['HDEL', SNAP_INDEX, k]));
  return stale.length;
}

/** What backups exist, newest first. For the operator screen. */
export async function listBackups() {
  const idx = parseHash(await cmd(['HGETALL', SNAP_INDEX]));
  return Object.keys(idx).sort().reverse().map((s) => ({ stamp: s, ...idx[s] }));
}

/** One site's record as it stood on a given day. The point of the whole thing. */
export async function restorePreview(stampStr, slug) {
  const raw = await cmd(['GET', snapKey(stampStr)]);
  if (!raw) return null;
  let snap;
  try { snap = JSON.parse(raw); } catch { return null; }
  const rec = snap.sites && snap.sites[slug];
  if (!rec) return null;
  try { return JSON.parse(rec); } catch { return null; }
}

// ---- uptime ----
// "Watched around the clock" means somebody notices before the customer does.
// Every published site is fetched on a schedule and anything that is not a 200
// is reported. Deliberately a READ ONLY check: it can observe, never repair.

const UP_KEY = 'ks:uptime';

/**
 * Check every published site. Returns the failures.
 * @param {function} fetchFn injected so this is testable without a network
 */
export async function checkUptime(base, sites, fetchFn = fetch, now = new Date()) {
  const failures = [];
  const results = {};

  for (const s of sites) {
    const url = base + '/s/' + s.slug;
    let ok = false, status = 0;
    try {
      const r = await fetchFn(url, { method: 'GET', redirect: 'manual' });
      status = r.status;
      ok = r.status >= 200 && r.status < 400;
    } catch (e) {
      status = 0;
    }
    results[s.slug] = { ok, status, at: now.toISOString() };
    if (!ok) failures.push({ slug: s.slug, business: s.business || s.slug, status });
  }

  await cmd(['SET', UP_KEY, JSON.stringify({ at: now.toISOString(), checked: sites.length, failures, results })]);
  return { checked: sites.length, failures };
}

/** Last uptime result, for the operator screen. */
export async function lastUptime() {
  const raw = await cmd(['GET', UP_KEY]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ---- the other half of "runs until your next billing date, then stops" ----
//
// Switching a module off keeps it live on the customer's site until the period
// they already paid for runs out. Something has to actually take it away when
// that day arrives, and it cannot be the panel, because a customer who switched
// something off has no reason to open the panel again.
//
// So this runs daily. It is the ONLY thing that ends a module, which is why the
// account's `ending` map is the single record of when each one expires.

/**
 * Remove modules whose paid period has now passed, and forget them.
 * @param {object} deps { getAccounts, saveAccounts, removeModules }
 * @returns {Promise<{checked:number, expired:Array}>}
 */
export async function sweepExpired({ getAccounts, saveAccounts, removeModules }, now = Date.now()) {
  const nowSec = Math.floor(now / 1000);
  const accounts = await getAccounts();
  const emails = Object.keys(accounts);
  const expired = [];
  // ONLY THE ACCOUNTS THIS SWEEP ACTUALLY CHANGED GET WRITTEN BACK.
  //
  // This used to hand the whole set to saveAccounts at the end. The loop reads
  // every account, then does a network call per expiry, so it can be running for
  // a while; any customer who flips a switch during that window has their change
  // overwritten by the stale copy this cron has been holding since it started.
  // Writing only what changed means a sweep can no longer undo a customer's own
  // billing action, which is the exact class of bug the account split is for.
  const changed = {};

  for (const email of emails) {
    const acct = accounts[email];
    const ending = (acct && acct.ending) || {};
    const done = Object.keys(ending).filter((p) => !(ending[p] > nowSec));
    if (!done.length) continue;

    // What they still legitimately have: anything not expired.
    const keep = Object.keys(ending).filter((p) => ending[p] > nowSec);
    const next = {};
    for (const p of keep) next[p] = ending[p];
    accounts[email] = { ...acct, ending: next };
    changed[email] = accounts[email];
    expired.push({ email, phases: done });

    // Subtracting is safe: re-buying a module deletes its `ending` entry, so
    // anything still listed here genuinely has not been re-bought.
    try { await removeModules(email, done); }
    catch (e) { console.error('[sweep] remove', email, e); }
  }

  if (Object.keys(changed).length) await saveAccounts(changed);
  return { checked: emails.length, expired };
}
