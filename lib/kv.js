// One Upstash Redis (Vercel KV) client, shared. store.js and sites.js each had
// their own copy of this, including their own reading of the env vars, which is
// how they ended up with different capabilities.
//
// IT IS ALSO WHERE ONE FRANCHISEE'S DATA IS KEPT AWAY FROM ANOTHER'S.
//
// Every key in the system starts with `ks:` and only 25 places build one, all
// of them in lib/. That makes this the single chokepoint where a tenant can be
// separated, so no caller has to remember to do it and no new caller can forget.
//
//   root tenant   ks:site:joes-plumbing        (unchanged, see below)
//   tenant 'bob'  ks:t:bob:site:joes-plumbing
//
// THE ROOT TENANT KEEPS THE OLD KEYS ON PURPOSE. Prefixing everything would
// make every existing record invisible in one deploy: live customers, their
// sites, their billing links. Root reads and writes exactly what it does today,
// so this change is inert until a second tenant exists, and there is no
// migration to run and nothing to roll back.
//
// Env: KV_REST_API_URL/TOKEN (Vercel KV) or UPSTASH_REDIS_REST_URL/TOKEN.

import { AsyncLocalStorage } from 'node:async_hooks';

const URL_BASE = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export function configured() { return !!(URL_BASE && TOKEN); }

/** The home tenant: no prefix, so today's data is exactly where it already is. */
export const ROOT = '';

// ASYNCLOCALSTORAGE, NOT A MODULE VARIABLE, AND THIS IS THE WHOLE SAFETY ARGUMENT.
//
// A serverless instance handles many requests, and they interleave at every
// await. With a plain `let currentTenant`, request A could set 'bob', await a
// fetch, request B set 'alice', and when A resumes it reads 'alice' and serves
// bob one of alice's customers. That bug would be intermittent, invisible in
// testing, and a data breach between two paying businesses.
//
// AsyncLocalStorage binds the value to the async call chain instead, so each
// request keeps its own tenant across every await no matter what else is running.
const ctx = new AsyncLocalStorage();

/** Run everything inside `fn` as this tenant. Nested calls override, and the
 *  previous value is restored on the way out. */
export function runAsTenant(tenantId, fn) {
  return ctx.run({ id: String(tenantId || ROOT) }, fn);
}

/** Who this call belongs to. ROOT when nothing set it, which is today's behaviour. */
export function currentTenant() {
  const c = ctx.getStore();
  return c ? c.id : ROOT;
}

/**
 * Rewrite a key for the tenant that owns this call.
 *
 * Only touches strings that start with `ks:`. Anything else is passed straight
 * through untouched, so a command whose second argument is a value rather than
 * a key (and any future non-ks key) cannot be corrupted by this.
 */
export function keyFor(key, tenantId) {
  const t = tenantId === undefined ? currentTenant() : String(tenantId || ROOT);
  if (!t) return key;
  if (typeof key !== 'string' || !key.startsWith('ks:')) return key;
  if (key.startsWith('ks:t:')) return key;   // already scoped, never double-prefix
  return 'ks:t:' + t + ':' + key.slice(3);
}

// Every command this system uses is single-key with the key at args[1], and
// there are no multi-key commands (MGET, RENAME, COPY and friends are unused).
// Checked, not assumed: test/tenant.mjs asserts that the command set has not
// grown a multi-key member, so this stays true rather than merely being true now.
function scope(args) {
  if (!Array.isArray(args) || args.length < 2) return args;
  const k = keyFor(args[1]);
  if (k === args[1]) return args;
  const out = args.slice();
  out[1] = k;
  return out;
}

async function post(path, body) {
  const r = await fetch(URL_BASE + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('kv ' + r.status + ': ' + JSON.stringify(j).slice(0, 160));
  return j;
}

/** One command: cmd(['GET', 'key']). Scoped to the calling tenant. */
export async function cmd(args) {
  return (await post('', scope(args))).result;
}

/**
 * The same command against the ROOT tenant, whatever the caller is.
 *
 * For the handful of things that are genuinely system-wide rather than one
 * business's: the tenant registry itself, above all. Reading that through the
 * normal path would scope it to the tenant we are still trying to identify.
 */
export async function rootCmd(args) {
  return runAsTenant(ROOT, () => cmd(args));
}

/**
 * Many commands, one HTTP round trip. Bulk work is thousands of writes and one
 * request each would be thousands of round trips.
 * Falls back to sequential if the pipeline endpoint is unavailable, so this can
 * never be the reason a write does not happen.
 */
export async function pipeline(cmds) {
  if (!cmds || !cmds.length) return [];
  cmds = cmds.map(scope);
  try {
    const out = await post('/pipeline', cmds);
    return Array.isArray(out) ? out.map((x) => (x && Object.prototype.hasOwnProperty.call(x, 'result') ? x.result : x)) : [];
  } catch (e) {
    console.error('[kv] pipeline unavailable, falling back to sequential:', e.message);
    const out = [];
    for (const c of cmds) out.push(await cmd(c));
    return out;
  }
}

/** Upstash returns HGETALL as a flat [field, value, ...] array. Parse JSON values. */
export function parseHash(v) {
  const out = {};
  if (!v) return out;
  if (Array.isArray(v)) {
    for (let i = 0; i + 1 < v.length; i += 2) {
      try { out[v[i]] = JSON.parse(v[i + 1]); } catch { out[v[i]] = v[i + 1]; }
    }
    return out;
  }
  for (const [k, val] of Object.entries(v)) {
    try { out[k] = typeof val === 'string' ? JSON.parse(val) : val; } catch { out[k] = val; }
  }
  return out;
}
