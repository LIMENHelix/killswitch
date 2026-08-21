// WHO THIS REQUEST BELONGS TO.
//
// One deployment serves every franchisee. The domain says which one: a request
// to bobssites.com is Bob's, and every key it touches becomes ks:t:bob:...
// Nothing else in the codebase has to know that happened, because lib/kv.js
// does the scoping and this only decides the answer.
//
// THE HOME TENANT IS UNPREFIXED. killswitchwebsites.com is ROOT, and ROOT reads
// and writes exactly the keys it does today. So this file changes nothing until
// a second tenant is registered, and adding one cannot disturb the first.
//
// TWO RULES THAT KEEP ONE BUSINESS OUT OF ANOTHER'S DATA:
//
// 1. An UNKNOWN domain is an error, never a fallback to ROOT. A quiet fallback
//    is precisely the bug worth fearing here: a franchisee's domain that failed
//    to resolve would silently serve them the home tenant's customer list.
// 2. A tenant id is validated on the way in. It becomes part of a Redis key, so
//    a colon in it could let one tenant address another's keyspace.

import { rootCmd, runAsTenant, currentTenant, ROOT } from './kv.js';

const REGISTRY = 'ks:tenants';        // domain -> {id,name,...}, always at ROOT
const CACHE_MS = 60000;               // a domain lookup on every request would
let cache = { at: 0, byDomain: null }; // double the reads; a minute is plenty

export { ROOT, runAsTenant, currentTenant };

/** Lowercase host with any port stripped. `www.` is NOT stripped: a tenant may
 *  legitimately register only one of the two, and guessing is how you serve the
 *  wrong business. Register both if both should work. */
export function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().split(':')[0];
}

/** A tenant id must be safe to put inside a Redis key and inside a URL. */
export function validTenantId(id) {
  return /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(String(id || ''));
}

/** The domain -> tenant map, cached briefly. Read at ROOT, always. */
export async function registry(force = false) {
  const now = nowMs();
  if (!force && cache.byDomain && now - cache.at < CACHE_MS) return cache.byDomain;
  let map = {};
  try {
    const raw = await rootCmd(['HGETALL', REGISTRY]);
    if (Array.isArray(raw)) {
      for (let i = 0; i + 1 < raw.length; i += 2) {
        try { map[raw[i]] = JSON.parse(raw[i + 1]); } catch { map[raw[i]] = { id: raw[i + 1] }; }
      }
    } else if (raw && typeof raw === 'object') {
      for (const [d, v] of Object.entries(raw)) {
        try { map[d] = typeof v === 'string' ? JSON.parse(v) : v; } catch { map[d] = { id: String(v) }; }
      }
    }
  } catch (e) {
    // A registry we cannot read is not an empty registry. Returning {} here
    // would make every franchisee domain unknown, and rule 1 turns that into a
    // refusal rather than a leak, which is the correct way to fail.
    console.error('[tenant] registry unreadable', e.message);
    throw e;
  }
  cache = { at: now, byDomain: map };
  return map;
}

function nowMs() { return Date.now(); }

/** Forget the cached registry. Called after a tenant is added or changed. */
export function invalidate() { cache = { at: 0, byDomain: null }; }

/**
 * Which tenant owns this host.
 *
 * @returns {Promise<{id:string, name:string, root:boolean}>}
 * @throws when the host is not registered, deliberately. See rule 1 above.
 */
export async function tenantForHost(host, opts = {}) {
  const h = normalizeHost(host);
  const homes = new Set([
    ...(opts.homeDomains || []),
    ...String(process.env.KS_HOME_DOMAINS || 'killswitchwebsites.com,killswitch.domains,localhost,127.0.0.1')
      .split(',').map((s) => normalizeHost(s)).filter(Boolean),
  ]);
  // Our own deployment URLs are root. Vercel serves every deploy at
  // <project>-<hash>-<team>.vercel.app, and preview builds get a fresh host
  // every time, so they can never be in a list. Without this, wiring tenants in
  // would 404 every preview and any production request that arrived on the
  // deployment URL rather than the custom domain.
  if (!h || homes.has(h) || h.endsWith('.vercel.app')) {
    return { id: ROOT, name: 'Killswitch Websites', root: true };
  }

  const map = await registry();
  const hit = map[h];
  if (!hit || !hit.id) {
    const err = new Error('unknown_tenant_domain: ' + h);
    err.code = 'unknown_tenant_domain';
    throw err;
  }
  return { id: hit.id, name: hit.name || hit.id, root: false, ...hit };
}

/**
 * Run a request handler as whoever owns its Host header.
 *
 * The one place a handler becomes tenant-aware. Wrap it and nothing else in the
 * file changes, because every key it touches is scoped underneath.
 *
 * A preview deployment or an unregistered domain gets a plain refusal rather
 * than somebody else's data.
 */
export async function withTenant(req, res, fn) {
  let t;
  try {
    t = await tenantForHost(req && req.headers && req.headers.host);
  } catch (e) {
    console.error('[tenant]', e.message);
    if (res && !res.headersSent) {
      res.status(e.code === 'unknown_tenant_domain' ? 404 : 503)
        .json({ error: e.code || 'tenant_unavailable' });
    }
    return undefined;
  }
  return runAsTenant(t.id, () => fn(t));
}

// ---- managing tenants (root only; the caller is responsible for authorising) ----

/** Register a franchisee, or point another domain at an existing one. */
export async function addTenant({ id, domain, name, stripeAccount }) {
  const tid = String(id || '').trim().toLowerCase();
  const dom = normalizeHost(domain);
  if (!validTenantId(tid)) return { ok: false, error: 'bad_tenant_id' };
  if (!dom || dom.indexOf('.') < 1) return { ok: false, error: 'bad_domain' };

  const map = await registry(true);
  const existing = map[dom];
  if (existing && existing.id && existing.id !== tid) {
    // Repointing a live domain at a different franchisee would hand one
    // business another's customers on the next request. Never implicit.
    return { ok: false, error: 'domain_taken_by_' + existing.id };
  }

  const rec = {
    id: tid,
    name: String(name || tid).trim(),
    ...(stripeAccount ? { stripeAccount: String(stripeAccount).trim() } : {}),
    addedAt: (existing && existing.addedAt) || new Date().toISOString(),
  };
  await rootCmd(['HSET', REGISTRY, dom, JSON.stringify(rec)]);
  invalidate();
  return { ok: true, tenant: rec, domain: dom };
}

/** Stop serving a domain. The tenant's DATA is untouched: this is a disconnect,
 *  not a delete, so pointing the domain back restores everything. */
export async function removeDomain(domain) {
  const dom = normalizeHost(domain);
  if (!dom) return { ok: false, error: 'bad_domain' };
  const map = await registry(true);
  if (!map[dom]) return { ok: false, error: 'not_found' };
  await rootCmd(['HDEL', REGISTRY, dom]);
  invalidate();
  return { ok: true, domain: dom, wasTenant: map[dom].id };
}

/** Every franchisee, with the domains that reach them. For the franchise portal. */
export async function listTenants() {
  const map = await registry(true);
  const byId = {};
  for (const [domain, rec] of Object.entries(map)) {
    const id = rec && rec.id;
    if (!id) continue;
    byId[id] = byId[id] || { id, name: rec.name || id, domains: [], addedAt: rec.addedAt || '', stripeAccount: rec.stripeAccount || '' };
    byId[id].domains.push(domain);
  }
  return Object.values(byId).sort((a, b) => String(a.addedAt).localeCompare(String(b.addedAt)));
}
