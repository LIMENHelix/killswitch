// Lead list and customer accounts. The lead list lives under one key as a JSON
// array: it is read whole by the board and by the mailer either way, so splitting
// it buys nothing. Per-lead working notes are a hash (see below), and SITES are
// one key each (see lib/sites.js), because those are read one at a time.

import { cmd, pipeline, parseHash, configured } from './kv.js';

const KEY = 'ks:leads';
const INBOUND_KEY = 'ks:leads:inbound';

export { configured };

export async function getLeads() {
  const v = await cmd(['GET', KEY]);
  let base = [];
  if (v) { try { base = JSON.parse(v); } catch { base = []; } }
  const inbound = Object.values(parseHash(await cmd(['HGETALL', INBOUND_KEY])));
  const seen = new Set(base.map((lead) => lead && lead.id).filter(Boolean));
  return base.concat(inbound.filter((lead) => lead && !seen.has(lead.id)));
}

export async function saveLeads(arr) {
  await cmd(['SET', KEY, JSON.stringify(arr)]);
}

/** Atomic per-lead append for public signup, so simultaneous signups cannot erase each other. */
export async function appendInboundLead(lead) {
  const id = String(lead && lead.id || '').trim();
  if (!id) throw new Error('lead id required');
  await cmd(['HSET', INBOUND_KEY, id, JSON.stringify(lead)]);
  return lead;
}

// ---- per-lead working notes (stage, notes, owner) ----
// These live in a Redis HASH, one field per lead, NOT in the big leads blob.
//
// The blob is read-modify-written whole. With one person on the board that is
// fine. With a rep and the operator both working it, or one person in two tabs
// against a 20 second auto-refresh, the later write silently erased the earlier
// one's stage changes and notes. A hash field is written on its own, so two
// people working different leads can no longer overwrite each other.
const META_KEY = 'ks:leadmeta';

export async function getLeadMeta() {
  return parseHash(await cmd(['HGETALL', META_KEY]));
}

/** Merge per-lead notes onto lead records. One HGETALL, not one per lead. */
export async function withMeta(leads) {
  const meta = await getLeadMeta();
  return leads.map((l) => (meta[l.id] ? { ...l, ...meta[l.id] } : l));
}

/** Bulk meta write, one round trip. Used when generating drafts for thousands. */
export async function setLeadMetaMany(entries) {
  const cur = await getLeadMeta();
  const cmds = [];
  for (const [id, patch] of entries) {
    if (!id) continue;
    const next = { ...(cur[id] || {}) };
    for (const [k, v] of Object.entries(patch || {})) if (v !== undefined) next[k] = v;
    cmds.push(['HSET', META_KEY, String(id), JSON.stringify(next)]);
  }
  await pipeline(cmds);
  return cmds.length;
}

export async function setLeadMeta(id, patch) {
  const key = String(id || '');
  if (!key) return null;
  let cur = {};
  const raw = await cmd(['HGET', META_KEY, key]);
  if (raw) { try { cur = JSON.parse(raw) || {}; } catch { cur = {}; } }
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch || {})) if (v !== undefined) next[k] = v;
  await cmd(['HSET', META_KEY, key, JSON.stringify(next)]);
  return next;
}

// ---- autopilot config (one small JSON blob) ----
const CFG_KEY = 'ks:autopilot';
const CFG_DEFAULT = {
  enabled: false, dailyCap: 0, budgetCeiling: 0,
  mailedToday: 0, dayStamp: '', lastRun: null,
};
export async function getConfig() {
  const v = await cmd(['GET', CFG_KEY]);
  if (!v) return { ...CFG_DEFAULT };
  try { return { ...CFG_DEFAULT, ...JSON.parse(v) }; } catch { return { ...CFG_DEFAULT }; }
}
export async function saveConfig(cfg) {
  await cmd(['SET', CFG_KEY, JSON.stringify(cfg)]);
}

// ---- customer accounts (free + paid), ONE HASH FIELD EACH ----
//
// A free customer has an account with plan ['P0'] and no Stripe object. When
// they flip on a paid switch, stripeCustomerId gets attached.
//
// THIS USED TO BE ONE JSON BLOB, AND THAT SILENTLY CORRUPTED BILLING.
//
// Every read of one account read all of them, and every write rewrote all of
// them. 22 places read it, 9 rewrote it. So two customers flipping a switch in
// the same second did this:
//
//   A reads all accounts        B reads all accounts
//   A writes its copy back      B writes ITS copy back, still holding A's old data
//                               -> A's change is gone, and nothing errored
//
// What gets erased is `ending`, the map that decides when a switched-off module
// actually stops being paid for. So the failure is a customer still being
// charged for something they turned off, or losing something they paid for,
// with both operations reporting success. At ten customers you never see it. At
// a hundred, with three crons also writing, it happens.
//
// The fix is the one THIS FILE ALREADY APPLIES to per-lead notes thirty lines
// up, for exactly the same reason: a hash field is written on its own, so two
// people working different records cannot overwrite each other. Accounts simply
// never got the same treatment.
//
//   ks:acct       hash, one field per email, holding that account's JSON
//   ks:accounts   the old blob, read-only, kept as a backstop
//
// Old data self-heals: a miss on the hash falls back to the blob and writes the
// record forward, so nothing breaks during the change and there is no migration
// anyone has to remember to run.
const ACC_HASH = 'ks:acct';
const ACC_KEY = 'ks:accounts';   // legacy blob, never written again
function normEmail(e) { return String(e || '').trim().toLowerCase(); }

/** The old blob. Read only, and only ever consulted on a miss. */
async function legacyAccounts() {
  try {
    const v = await cmd(['GET', ACC_KEY]);
    if (!v) return {};
    return JSON.parse(v) || {};
  } catch { return {}; }
}

/** Every account. One HGETALL rather than a blob parse. */
export async function getAccounts() {
  const h = parseHash(await cmd(['HGETALL', ACC_HASH]));
  if (Object.keys(h).length) return h;
  // Nothing in the hash yet: this is the first run after the split, or there
  // are genuinely no customers. Carry the old blob forward if it has anything.
  const legacy = await legacyAccounts();
  const emails = Object.keys(legacy);
  if (!emails.length) return {};
  await pipeline(emails.map((e) => ['HSET', ACC_HASH, e, JSON.stringify(legacy[e])]));
  console.log('[store] migrated', emails.length, 'account(s) out of the legacy blob');
  return legacy;
}

/**
 * Write many accounts at once.
 *
 * NOTE THE CHANGED SEMANTICS, DELIBERATELY. The old version replaced the entire
 * account set with whatever it was handed, so one caller passing a partial map
 * would delete every customer missing from it. This writes the accounts it was
 * given and leaves the rest alone. Every existing caller passes the full map, so
 * nothing behaves differently today, and the foot-gun is gone.
 */
export async function saveAccounts(map) {
  const entries = Object.entries(map || {}).filter(([e]) => e);
  if (!entries.length) return 0;
  await pipeline(entries.map(([e, a]) => ['HSET', ACC_HASH, normEmail(e), JSON.stringify(a)]));
  return entries.length;
}

/** One account. A single HGET, not a read of every customer in the system. */
export async function getAccount(email) {
  const e = normEmail(email);
  if (!e) return null;
  const raw = await cmd(['HGET', ACC_HASH, e]);
  if (raw) {
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  }
  // Miss. Might predate the split, so look in the old blob and carry it forward.
  const legacy = await legacyAccounts();
  const hit = legacy[e];
  if (!hit) return null;
  await cmd(['HSET', ACC_HASH, e, JSON.stringify(hit)]);
  return hit;
}

/**
 * Create or update one account.
 *
 * Still a read-modify-write, but of ONE FIELD instead of the whole system. Two
 * customers can no longer erase each other, which was the actual bug. Two writes
 * to the SAME account in the same instant can still race, and that is worth
 * saying plainly rather than claiming this is atomic: the window is one
 * customer's own concurrent actions, not any two customers in the business.
 */
export async function upsertAccount(acct) {
  const email = normEmail(acct && acct.email);
  if (!email) throw new Error('email required');
  const cur = (await getAccount(email)) || {};
  const next = { ...cur, ...acct, email };
  await cmd(['HSET', ACC_HASH, email, JSON.stringify(next)]);
  return next;
}
