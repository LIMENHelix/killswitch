// Tiny Upstash Redis (Vercel KV) helper. The whole lead list lives under one key
// as a JSON array — plenty for a few thousand leads, no schema, no migrations.
// Env: KV_REST_API_URL/TOKEN (Vercel KV) or UPSTASH_REDIS_REST_URL/TOKEN.

const URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = 'ks:leads';

export function configured() { return !!(URL && TOKEN); }

async function cmd(args) {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('kv ' + r.status + ': ' + JSON.stringify(j).slice(0, 160));
  return j.result;
}

export async function getLeads() {
  const v = await cmd(['GET', KEY]);
  if (!v) return [];
  try { return JSON.parse(v); } catch { return []; }
}

export async function saveLeads(arr) {
  await cmd(['SET', KEY, JSON.stringify(arr)]);
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
