// Lead list and customer accounts. The lead list lives under one key as a JSON
// array: it is read whole by the board and by the mailer either way, so splitting
// it buys nothing. Per-lead working notes are a hash (see below), and SITES are
// one key each (see lib/sites.js), because those are read one at a time.

import { cmd, pipeline, parseHash, configured } from './kv.js';

const KEY = 'ks:leads';

export { configured };

export async function getLeads() {
  const v = await cmd(['GET', KEY]);
  if (!v) return [];
  try { return JSON.parse(v); } catch { return []; }
}

export async function saveLeads(arr) {
  await cmd(['SET', KEY, JSON.stringify(arr)]);
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

// ---- customer accounts (free + paid), one JSON map keyed by lowercased email ----
// A free customer has an account with plan ['P0'] and no Stripe object. When they
// flip on a paid switch, stripeCustomerId gets attached. Same shelf as leads.
const ACC_KEY = 'ks:accounts';
function normEmail(e) { return String(e || '').trim().toLowerCase(); }

export async function getAccounts() {
  const v = await cmd(['GET', ACC_KEY]);
  if (!v) return {};
  try { return JSON.parse(v) || {}; } catch { return {}; }
}
export async function saveAccounts(map) {
  await cmd(['SET', ACC_KEY, JSON.stringify(map)]);
}
export async function getAccount(email) {
  const m = await getAccounts();
  return m[normEmail(email)] || null;
}
export async function upsertAccount(acct) {
  const email = normEmail(acct && acct.email);
  if (!email) throw new Error('email required');
  const m = await getAccounts();
  m[email] = { ...(m[email] || {}), ...acct, email };
  await saveAccounts(m);
  return m[email];
}
