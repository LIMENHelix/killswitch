// K4 — bounded autonomous prospect discovery and ranking. UPSTREAM ONLY.
//
// This module discovers businesses via Google Places, gives each one a durable
// canonical identity (the Google Place ID, which the manual finder used to
// discard), reconciles it against existing Killswitch state, scores it with a
// pure deterministic function, and STOPS. It contacts nobody: no mailer, no
// Lob, no Resend outreach, no voice agent, no site drafting, no publishing.
// The import list below is the whole safety argument — kv, web-presence,
// suppression, sites. Nothing outbound lives in this graph.
//
// MONEY PATH. Places calls are paid, so EVERY request passes this gate chain:
//
//   config gate → run lease (owned, renewed) → deterministic call id →
//   ONE ATOMIC Lua reservation (call-id dedupe + daily cap + run cap +
//   both counters + call ledger) → request → outcome recorded → candidates
//
// The reservation is pessimistic: a call that may have reached Google
// (timeout, 5xx, crash after issue) STAYS counted. Counters are never
// decremented. Same logical call id can never consume a second reservation,
// so duplicate invocation, lease expiry, or crash/retry cannot double-spend.
//
// Everything is gated by a config that DEFAULTS OFF (ks:disc:cfg, same pattern
// as the postcard autopilot's ks:autopilot). An absent or malformed config can
// never enable discovery, and any missing cap fails the run closed with zero
// Places calls. Production caps, geography, trades and ranking policy are
// CHRIS DECISIONS: this file ships no production values.

import crypto from 'node:crypto';
import { cmd, parseHash, keyFor } from './kv.js';
import { classify } from './web-presence.js';
import { getSuppressionState, matchSuppression } from './suppression.js';
import { listSites } from './sites.js';

// Places (New) searchText. Same endpoint and field mask as api/find.js — one
// shared definition so the manual finder and the autonomous loop can never
// drift apart on what a "lead" is.
export const FIELDMASK = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.addressComponents',
  'places.nationalPhoneNumber', 'places.websiteUri',
  'places.businessStatus',
  'places.regularOpeningHours',
  'places.primaryTypeDisplayName',
  'places.editorialSummary',
  'places.rating', 'places.userRatingCount',
  'nextPageToken',
].join(',');

// Hard ceiling on pages per slot per run, matching the manual finder's
// long-standing 2-page bound. Not a configurable production preference: it is
// the existing behavior of api/find.js, kept identical.
export const MAX_PAGES_PER_SLOT = 2;
const PAGE_DELAY_MS = 2100;   // Places asks for ~2s between page tokens
export const FETCH_TIMEOUT_MS = 10000; // audited weakness: find.js had NO server-side timeout
const LEASE_TTL_MS = 120000;  // renewed around every external request

export async function placesSearch({ query, key, pageToken = null, fetchFn = fetch }) {
  const body = { textQuery: query, pageSize: 20 };
  if (pageToken) body.pageToken = pageToken;
  let r;
  try {
    r = await fetchFn('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELDMASK },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    // A local throw means the request MAY have reached Google — connection
    // reset, DNS failure, abort. Count it as spent (the reservation already
    // did) and classify it as the ambiguous outcome.
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw Object.assign(new Error('places timeout after ' + FETCH_TIMEOUT_MS + 'ms'), { outcome: 'timeout' });
    throw Object.assign(new Error('places request failed: ' + String(e && e.message || e).slice(0, 160)), { outcome: 'timeout' });
  }
  if (!r.ok) throw Object.assign(new Error('places ' + r.status + ': ' + (await r.text()).slice(0, 200)), { outcome: r.status >= 500 ? 'upstream_5xx' : 'upstream_4xx' });
  const j = await r.json().catch(() => null);
  if (!j || !Array.isArray(j.places)) throw Object.assign(new Error('places malformed response'), { outcome: 'malformed_response' });
  return j;
}

// ---- config (defaults OFF; arming requires explicit caps + plan) ----

const CFG_KEY = 'ks:disc:cfg';
export const DISC_DEFAULT = {
  enabled: false,
  perRunCap: 0,     // max Places CALLS one run may reserve
  dailyCap: 0,      // max Places calls per UTC day
  slotsPerRun: 0,   // plan slots processed per invocation
  plan: [],         // [{trade, city}] — EMPTY until Chris supplies it
  weights: null,    // ranking policy; null = neutral equal weights (see rankCandidate)
};

export async function getDiscConfig() {
  const v = await cmd(['GET', CFG_KEY]);
  if (!v) return { ...DISC_DEFAULT };
  try { return { ...DISC_DEFAULT, ...JSON.parse(v) }; } catch { return { ...DISC_DEFAULT }; }
}

/** A config is armable only with every cap present and a non-empty plan. */
export function discConfigArmable(cfg) {
  const c = cfg || {};
  return !!(c.enabled)
    && Number(c.perRunCap) > 0
    && Number(c.dailyCap) > 0
    && Number(c.slotsPerRun) > 0
    && Array.isArray(c.plan) && c.plan.length > 0
    && c.plan.every((s) => s && String(s.trade || '').trim() && String(s.city || '').trim());
}

export async function saveDiscConfig(cfg) {
  await cmd(['SET', CFG_KEY, JSON.stringify(cfg)]);
  return cfg;
}

/** Validate an operator patch; returns {config} or {error}. Enforces the same
 *  arming discipline as the autopilot setconfig: enabling without caps+plan is
 *  refused, so a malformed save can never arm spend. `resetCursor` (owner
 *  only) restarts the plan from slot 0 — the recovery path for a slot that hit
 *  the permanent 3-failure skip. */
export function validateDiscConfigPatch(cur, body) {
  const next = { ...cur };
  if (body.enabled !== undefined) next.enabled = !!body.enabled;
  for (const k of ['perRunCap', 'dailyCap', 'slotsPerRun']) {
    if (body[k] !== undefined) next[k] = Math.max(0, Math.floor(Number(body[k]) || 0));
  }
  if (body.plan !== undefined) {
    if (!Array.isArray(body.plan)) return { error: 'plan must be an array of {trade, city}' };
    next.plan = body.plan.slice(0, 500).map((s) => ({ trade: String(s.trade || '').trim(), city: String(s.city || '').trim() })).filter((s) => s.trade && s.city);
  }
  if (body.weights !== undefined) {
    if (body.weights === null) next.weights = null;
    else {
      const w = {};
      for (const k of RANK_COMPONENTS) if (body.weights[k] !== undefined) w[k] = Math.max(0, Number(body.weights[k]) || 0);
      next.weights = w;
    }
  }
  if (next.enabled && !discConfigArmable(next)) {
    return { error: 'incomplete_config', message: 'Enabling discovery requires perRunCap > 0, dailyCap > 0, slotsPerRun > 0 and a non-empty {trade, city} plan. Nothing was saved.' };
  }
  return { config: next };
}

// ---- durable state ----

const CANDS_KEY = 'ks:disc:cands';     // hash: placeId -> candidate JSON
const RUNS_KEY = 'ks:disc:runs';       // hash: runId -> run ledger JSON
const CALLS_KEY = 'ks:disc:calls';     // hash: callId -> call reservation/outcome JSON
const CURSOR_KEY = 'ks:disc:cursor';   // blob: {index, updatedAt, failures}
const LEASE_KEY = 'ks:disc:lease';     // owned value: compare-and-renew/release only
const DAY_KEY = (d) => 'ks:disc:day:' + d;          // UTC day Places-call counter
const RUNC_KEY = (runId) => 'ks:disc:rc:' + runId;  // per-run reserved-call counter
const SLOT_FAILURE_GIVEUP = 3;         // consecutive failures before a slot is skipped for good

const clean = (v, n = 200) => String(v == null ? '' : v).trim().slice(0, n);
const norm = (v) => clean(v).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Explicit UTC accounting day (YYYY-MM-DD). toISOString is always UTC, so
 *  there is exactly one defined boundary — UTC midnight — everywhere. */
const utcDay = (d) => d.toISOString().slice(0, 10);

export async function getCandidates() { return parseHash(await cmd(['HGETALL', CANDS_KEY])); }
export async function getRuns() { return parseHash(await cmd(['HGETALL', RUNS_KEY])); }
export async function getCallLedger() { return parseHash(await cmd(['HGETALL', CALLS_KEY])); }

async function getCursor() {
  const v = await cmd(['GET', CURSOR_KEY]);
  if (!v) return { index: 0, updatedAt: '', failures: {} };
  try { return { index: 0, updatedAt: '', failures: {}, ...JSON.parse(v) }; } catch { return { index: 0, updatedAt: '', failures: {} }; }
}
async function saveCursor(c) { await cmd(['SET', CURSOR_KEY, JSON.stringify(c)]); }

/** Owner recovery path: restart the plan from slot 0 (e.g. after a permanent
 *  3-failure skip). Owner-gated at the API layer. */
export async function resetDiscCursor() {
  const c = { index: 0, updatedAt: new Date().toISOString(), failures: {} };
  await saveCursor(c);
  return c;
}

async function getDayCalls(d) {
  const v = await cmd(['GET', DAY_KEY(d)]);
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

// ---- atomic money-path primitives (Lua/EVAL) ----
//
// Upstash executes one Lua script atomically (single-threaded per keyspace),
// which is the ONLY mechanism here that satisfies the reservation invariant:
// call-id dedupe, both cap checks, both counter increments, and the call
// ledger write happen in one uninterruptible step. A pipeline is NOT
// sufficient (sequential, not transactional) and check-then-INCR in separate
// commands is exactly the race this replaces. Keys are pre-scoped with
// keyFor() because kv.js's command scoper only rewrites args[1], and EVAL's
// keys live at args[3..] — see lib/kv.js.
async function evalKeys(script, keys, args) {
  const scoped = keys.map((k) => keyFor(k));
  return cmd(['EVAL', script, String(scoped.length), ...scoped, ...args.map((a) => String(a))]);
}

// Markers let the test mock identify which invariant each script implements.
const RESERVE_SCRIPT = `
-- disc_reserve_v1
-- KEYS: 1=day counter, 2=run counter, 3=call ledger hash
-- ARGV: 1=callId 2=dailyCap 3=runCap 4=call record JSON
if redis.call('HEXISTS', KEYS[3], ARGV[1]) == 1 then return 'ALREADY_RESERVED' end
local d = tonumber(redis.call('GET', KEYS[1]) or '0')
if d >= tonumber(ARGV[2]) then return 'DAILY_CAP' end
local r = tonumber(redis.call('GET', KEYS[2]) or '0')
if r >= tonumber(ARGV[3]) then return 'RUN_CAP' end
redis.call('INCR', KEYS[1])
redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[3], ARGV[1], ARGV[4])
return 'RESERVED'`;

const LEASE_RENEW_SCRIPT = `
-- disc_lease_renew_v1
-- KEYS: 1=lease. ARGV: 1=owner 2=ttlMs. Renew only if still ours.
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PSETEX', KEYS[1], ARGV[2], ARGV[1])
else
  return 'LOST'
end`;

const LEASE_RELEASE_SCRIPT = `
-- disc_lease_release_v1
-- KEYS: 1=lease. ARGV: 1=owner. Release only if still ours; never delete another worker's lease.
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end`;

/**
 * The atomic reservation. One of:
 *   RESERVED         — capacity consumed, call ledger written, MAY issue request
 *   ALREADY_RESERVED — this logical call was reserved before; NEVER re-issue
 *   DAILY_CAP        — no mutation; stop with cap reason
 *   RUN_CAP          — no mutation; stop with cap reason
 */
export async function reserveCall({ callId, runId, day, slotFp, page, dailyCap, runCap, reservedAt }) {
  const record = JSON.stringify({ callId, runId, day, slotFp, page, reservedAt, outcome: 'reserved', completedAt: '' });
  const status = await evalKeys(RESERVE_SCRIPT, [DAY_KEY(day), RUNC_KEY(runId), CALLS_KEY], [callId, dailyCap, runCap, record]);
  return { status, callId };
}

export async function markCallOutcome(callId, patch) {
  const raw = await cmd(['HGET', CALLS_KEY, callId]);
  let rec = null;
  try { rec = raw ? JSON.parse(raw) : null; } catch { rec = null; }
  if (!rec) return null;
  const next = { ...rec, ...patch };
  await cmd(['HSET', CALLS_KEY, callId, JSON.stringify(next)]);
  return next;
}

export async function acquireLease(owner, ttlMs = LEASE_TTL_MS) {
  const v = await cmd(['SET', LEASE_KEY, owner, 'NX', 'PX', ttlMs]);
  return v === 'OK';
}
export async function renewLease(owner, ttlMs = LEASE_TTL_MS) {
  const v = await evalKeys(LEASE_RENEW_SCRIPT, [LEASE_KEY], [owner, ttlMs]);
  return v === 'OK';
}
export async function releaseLease(owner) {
  const v = await evalKeys(LEASE_RELEASE_SCRIPT, [LEASE_KEY], [owner]);
  return v === 1 || v === '1';
}

// ---- identity + normalization ----

export function parseAddr(components) {
  const g = {};
  for (const c of components || []) {
    const t = c.types || [];
    if (t.includes('street_number')) g.num = c.longText || '';
    else if (t.includes('route')) g.route = c.longText || '';
    else if (t.includes('locality')) g.city = c.longText || '';
    else if (t.includes('postal_town') && !g.city) g.city = c.longText || '';
    else if (t.includes('administrative_area_level_1')) g.state = c.shortText || '';
    else if (t.includes('postal_code')) g.zip = c.longText || '';
  }
  return {
    street: [g.num, g.route].filter(Boolean).join(' ').trim(),
    city: g.city || '', state: g.state || '', zip: g.zip || '',
  };
}

/**
 * Turn one raw Places result into a normalized candidate. The Place ID is the
 * canonical external identity — a business rediscovered by any query, city, or
 * run collapses to this one key. Returns null when there is no usable Place ID:
 * autonomous persistence fails closed rather than inventing an identity.
 */
export function normalizePlace(place, slot) {
  const placeId = clean(place && place.id, 120);
  if (!placeId) return null;
  const web = classify((place && place.websiteUri) || '');
  return {
    placeId,
    name: clean((place.displayName || {}).text, 160),
    ...parseAddr(place.addressComponents),
    phone: clean(place.nationalPhoneNumber, 40),
    domain: web.host,
    webUrl: web.url,
    webStatus: web.status,
    category: clean((place.primaryTypeDisplayName || {}).text, 120),
    rating: Number(place.rating) || 0,
    reviews: Number(place.userRatingCount) || 0,
    businessStatus: clean(place.businessStatus, 40) || 'OPERATIONAL',
    slotTrade: clean(slot && slot.trade, 60),
    slotCity: clean(slot && slot.city, 80),
  };
}

// ---- exclusion / reconciliation ----

/**
 * Decide whether a candidate is eligible to rank, purely from durable truth
 * loaded once per run. Strong exact matches only — similar names are NOT
 * matches, and an ambiguous identity is excluded for review rather than guessed.
 * Returns null (eligible) or {reason, detail}.
 *
 * LIMITATION (K5/K6 prerequisite): a customer whose account/site name does not
 * exactly match the Places business name cannot be reconciled and may rank.
 * Safe today ONLY because ranked is terminal — K4 contacts nobody. Customer/
 * paid eligibility must be re-derived before any draft/contact action.
 */
export function exclusionFor(cand, { suppressionState, siteList }) {
  if (cand.businessStatus && cand.businessStatus !== 'OPERATIONAL') {
    return { reason: 'not_operational', detail: 'permanently closed or not trading' };
  }
  const sup = matchSuppression({
    phone: cand.phone,
    street: cand.street, city: cand.city, state: cand.state, zip: cand.zip,
  }, suppressionState || {});
  if (sup) return { reason: 'suppressed', detail: 'do-not-contact record matched by phone or address fingerprint' };

  if (cand.webStatus === 'has_site') {
    return { reason: 'has_website', detail: 'they already own a website — not a target' };
  }

  // Exact business + city against the site index. Claimed means a customer;
  // unclaimed means a draft already exists for this business. Both stop the
  // candidate from being worked twice. More than one same-name same-city site
  // is ambiguous identity — exclude for review instead of guessing.
  const cn = norm(cand.name), cc = norm(cand.city);
  if (cn && cc) {
    const hits = (siteList || []).filter((s) => norm(s.business) === cn && norm(s.city) === cc);
    if (hits.length > 1) return { reason: 'ambiguous_identity', detail: 'multiple existing sites share this name and city' };
    if (hits.length === 1) {
      return hits[0].claimed
        ? { reason: 'claimed_site', detail: 'a claimed customer site already exists for this business' }
        : { reason: 'existing_site', detail: 'an unclaimed site or draft already exists for this business' };
    }
  }
  return null;
}

// ---- deterministic ranking ----

// Every component is 0..1, computed only from facts discovery already returned.
// webPresence is grounded in existing product semantics: TARGET_STATUSES (the
// classes web-presence.js already treats as worth building for) score 1, a real
// owned site scores 0 — but those are excluded before ranking anyway. The
// others are reputation and demand numbers straight from the Places response.
// Weights default to neutral equal weights; a production weighting policy is a
// CHRIS DECISION supplied through config (validateDiscConfigPatch), never a
// silent default chosen here.
export const RANK_COMPONENTS = ['webPresence', 'reputation', 'demand', 'geoExact'];

export function rankComponents(cand) {
  return {
    webPresence: cand.webStatus && cand.webStatus !== 'has_site' ? 1 : 0,
    reputation: Math.max(0, Math.min(5, Number(cand.rating) || 0)) / 5,
    demand: Math.max(0, Math.min(100, Number(cand.reviews) || 0)) / 100,
    geoExact: norm(cand.city) && norm(cand.city) === norm(cand.slotCity) ? 1 : 0,
  };
}

export function rankCandidate(cand, weights) {
  const parts = rankComponents(cand);
  const w = weights && RANK_COMPONENTS.every((k) => Number(weights[k]) >= 0) ? weights : { webPresence: 1, reputation: 1, demand: 1, geoExact: 1 };
  let score = 0;
  for (const k of RANK_COMPONENTS) score += (Number(w[k]) || 0) * parts[k];
  return { score: +score.toFixed(6), parts };
}

// ---- candidate merge ----

// Pure merge — the caller persists once. Identity fields (placeId,
// discoveredAt, firstRunId, query history) are stable; the factual snapshot
// refreshes; lastSeen/lastRun always move. Exclusion below is RE-DERIVED
// from current durable truth on every sighting, so suppression/customer/site
// state can never be lost because Places facts refreshed.
function mergeCandidate(existing, norm0, runId, now) {
  const first = existing || {};
  const queries = Array.isArray(first.queries) ? first.queries.slice(-9) : [];
  const lastQ = queries[queries.length - 1];
  if (!(lastQ && lastQ.trade === norm0.slotTrade && lastQ.city === norm0.slotCity)) {
    queries.push({ trade: norm0.slotTrade, city: norm0.slotCity, at: now });
  }
  return {
    cand: {
      ...first,
      ...norm0,
      queries,
      discoveredAt: first.discoveredAt || now,
      lastSeenAt: now,
      firstRunId: first.firstRunId || runId,
      lastRunId: runId,
    },
    isNew: !existing,
  };
}

// ---- the bounded run ----

/**
 * One bounded discovery run. Caller (the cron handler) has already checked
 * auth; this function re-checks every gate itself, because a run that can
 * spend money re-verifies everything. Money-path ordering per request:
 *
 *   gates → lease acquire (owned) → [per page: lease renew → deterministic
 *   callId → ATOMIC reserve (dedupe/daily/run/counters/ledger) → request →
 *   outcome] → lease renew → complete/advance (only if still the owner)
 *
 * Options are injection seams for tests: fetchFn, clock (returns Date),
 * leaseTtlMs. No production behavior depends on them.
 */
export async function runDiscovery({ fetchFn = fetch, clock = () => new Date(), leaseTtlMs = LEASE_TTL_MS } = {}) {
  // Preview deploys share the production Places key. The KV layer namespaces
  // preview data away from live customers, but a Places call from a preview
  // would still be REAL spend — so preview runs nothing, ever.
  if (process.env.VERCEL_ENV === 'preview') return { ran: false, reason: 'preview_disabled', calls: 0 };
  const key = process.env.GOOGLE_PLACES_API_KEY;
  const cfg = await getDiscConfig();
  if (!cfg.enabled) return { ran: false, reason: 'disabled', calls: 0 };
  if (!key) return { ran: false, reason: 'no_places_key', calls: 0 };
  if (!discConfigArmable(cfg)) return { ran: false, reason: 'incomplete_config', calls: 0 };

  const owner = 'own-' + crypto.randomBytes(8).toString('hex');
  if (!(await acquireLease(owner, leaseTtlMs))) return { ran: false, reason: 'lease_held', calls: 0 };

  const run = {
    id: '', slot: null, status: 'failed', startedAt: clock().toISOString(), finishedAt: '',
    calls: 0, // RESERVED (attempted) paid calls — not just successful responses
    raw: 0, newCount: 0, updatedCount: 0, excludedCount: 0, rankedCount: 0,
    capStop: '', stopReason: '', error: '', days: [],
  };

  try {
    const cursor = await getCursor();
    const [suppressionState, siteList] = await Promise.all([getSuppressionState(), listSites()]);
    const weights = cfg.weights;
    // Loaded once per lease holder: the lease fences other workers, so the
    // in-memory map is authoritative for this run's writes.
    const candMap = await getCandidates();

    let newSlots = Math.max(1, Math.floor(cfg.slotsPerRun));
    let sawCompleted = false;
    // Catch-up scans at most the whole plan once: if every slot is already
    // done, every iteration is a `continue`, so without this bound a fully
    // completed plan would spin forever.
    let scans = cfg.plan.length;

    while (newSlots > 0 && scans-- > 0) {
      const slotIdx = cursor.index % cfg.plan.length;
      const slot = cfg.plan[slotIdx];
      const slotKey = clean(slot.trade, 60) + '|' + clean(slot.city, 80);
      const runId = 'run-' + utcDay(clock()).replace(/-/g, '') + '-' + slotIdx;
      const prior = await cmd(['HGET', RUNS_KEY, runId]);
      if (prior) {
        const p = JSON.parse(prior);
        if (p.status === 'completed') { // already done — advance past it, no spend
          cursor.index = (cursor.index + 1) % cfg.plan.length;
          delete cursor.failures[slotKey];
          sawCompleted = true;
          continue;
        }
      }
      newSlots--;

      run.id = runId;
      run.slot = { trade: slot.trade, city: slot.city };

      const query = slot.trade + ' in ' + slot.city;
      const slotFp = 'trade:' + norm(slot.trade) + '|city:' + norm(slot.city);
      let pageToken = null, pages = 0;

      try {
        do {
          // Verify/renew ownership before EVERY external request, incl. page 2.
          if (!(await renewLease(owner, leaseTtlMs))) {
            run.stopReason = 'lease_lost';
            throw new Error('lease lost before request — abandoning without cursor advance');
          }
          if (run.capStop) break;

          const page = pages + 1;
          const callId = 'call-' + runId + '-p' + page; // deterministic logical call identity
          const reservedAt = clock().toISOString();
          const day = utcDay(clock()); // each request reserves against the UTC day at reservation time
          const resv = await reserveCall({
            callId, runId, day, slotFp, page,
            dailyCap: Math.floor(cfg.dailyCap), runCap: Math.floor(cfg.perRunCap),
            reservedAt,
          });
          if (resv.status === 'DAILY_CAP') { run.capStop = 'daily_cap'; break; }
          if (resv.status === 'RUN_CAP') { run.capStop = 'per_run_cap'; break; }
          if (resv.status === 'ALREADY_RESERVED') {
            // This exact logical call was reserved before and must never be
            // re-issued (duplicate invocation / lease-expiry replay / crash
            // retry). The reservation stands; the run fails safe.
            run.stopReason = 'ambiguous_prior_call';
            throw new Error('logical call ' + callId + ' already reserved — refusing to double-spend');
          }
          run.calls++; // reserved — counts even if the request fails below
          if (!run.days.includes(day)) run.days.push(day);

          let d;
          try {
            d = await placesSearch({ query, key, pageToken, fetchFn });
          } catch (e) {
            // Timeout / 5xx / malformed / local throw: the request may have
            // reached Google, so the reservation REMAINS COUNTED (never
            // decremented) and the outcome records the ambiguity.
            await markCallOutcome(callId, { outcome: e.outcome || 'timeout', completedAt: clock().toISOString() });
            throw e;
          }
          await markCallOutcome(callId, { outcome: 'success', completedAt: clock().toISOString() });
          pages++;
          run.raw += (d.places || []).length;

          for (const place of d.places || []) {
            const norm0 = normalizePlace(place, slot);
            if (!norm0) continue; // no usable Place ID: fail closed, no invented identity
            const existing = candMap[norm0.placeId] || null;
            const { cand, isNew } = mergeCandidate(existing, norm0, runId, run.startedAt);
            candMap[cand.placeId] = cand;

            const ex = exclusionFor(cand, { suppressionState, siteList });
            if (ex) {
              cand.status = 'excluded';
              cand.excludeReason = ex.reason;
              cand.excludeDetail = ex.detail;
              cand.score = 0; cand.parts = {};
              run.excludedCount++;
            } else {
              const { score, parts } = rankCandidate(cand, weights);
              cand.status = 'ranked';
              cand.excludeReason = '';
              cand.excludeDetail = '';
              cand.score = score;
              cand.parts = parts;
              run.rankedCount++;
            }
            await cmd(['HSET', CANDS_KEY, cand.placeId, JSON.stringify(cand)]);
            if (isNew) run.newCount++; else run.updatedCount++;
          }

          pageToken = run.capStop ? null : d.nextPageToken;
          if (pageToken && pages < MAX_PAGES_PER_SLOT) await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
          else pageToken = null;
        } while (pageToken);

        // Ownership again before declaring completion / advancing the cursor:
        // a stale worker must never mark a slot complete after losing the lease.
        if (!(await renewLease(owner, leaseTtlMs))) {
          run.stopReason = 'lease_lost';
          throw new Error('lease lost after requests — run not completed, cursor unmoved');
        }

        run.status = 'completed';
        run.finishedAt = clock().toISOString();
        await cmd(['HSET', RUNS_KEY, runId, JSON.stringify(run)]);
        // Success semantics: the slot is done — even when a cap stopped it
        // early, a capped partial slot is recorded truthfully with capStop and
        // the plan moves on (bounded spend wins over full coverage). ONLY
        // completed runs advance the cursor.
        cursor.index = (cursor.index + 1) % cfg.plan.length;
        delete cursor.failures[slotKey];
      } catch (e) {
        run.error = String(e && e.message || e).slice(0, 300);
        run.finishedAt = clock().toISOString();
        await cmd(['HSET', RUNS_KEY, runId, JSON.stringify(run)]).catch(() => {});
        // A failed run does NOT advance the cursor. After SLOT_FAILURE_GIVEUP
        // consecutive failures the slot is treated as permanently bad and
        // skipped so one broken query cannot stall the whole plan (owner can
        // reset the cursor via disc-setconfig {resetCursor:true}).
        cursor.failures[slotKey] = (cursor.failures[slotKey] || 0) + 1;
        if (cursor.failures[slotKey] >= SLOT_FAILURE_GIVEUP) {
          cursor.index = (cursor.index + 1) % cfg.plan.length;
          delete cursor.failures[slotKey];
        }
        break;
      }
    }

    cursor.updatedAt = clock().toISOString();
    await saveCursor(cursor);
    const reason = run.id ? (run.status === 'completed' ? 'completed' : 'failed') : (sawCompleted ? 'caught_up' : 'no_work');
    return { ran: run.id !== '', reason, run, calls: run.calls };
  } finally {
    // Compare-and-release: a worker never deletes a lease it no longer owns.
    await releaseLease(owner).catch(() => {});
  }
}

/**
 * Reconciliation audit: reserved call records must exactly match the atomic
 * counters for the UTC day and for each run touching it. Read-only; never
 * "repairs" downward — a mismatch is reported, not silently fixed.
 */
export async function auditCallAccounting(day) {
  const calls = Object.values(await getCallLedger());
  const dayCalls = calls.filter((c) => c && c.day === day);
  const dayCount = await getDayCalls(day);
  // Run counters are per RUN (a run may span two UTC days), so reconcile each
  // run's counter against its TOTAL call records, and the day counter against
  // the day's records — two separate exact equalities.
  const byRun = {};
  for (const c of calls) {
    if (!c) continue;
    byRun[c.runId] = byRun[c.runId] || { reserved: 0, days: new Set() };
    byRun[c.runId].reserved++;
    byRun[c.runId].days.add(c.day);
  }
  const runs = [];
  for (const [runId, info] of Object.entries(byRun)) {
    const v = await cmd(['GET', RUNC_KEY(runId)]);
    const counter = parseInt(v, 10);
    runs.push({ runId, reserved: info.reserved, counter: Number.isFinite(counter) ? counter : 0, days: [...info.days], reconciled: Number.isFinite(counter) && counter === info.reserved });
  }
  return { day, dayCount, dayReservations: dayCalls.length, reconciled: dayCount === dayCalls.length, runs };
}

// ---- operator read model ----

export async function discStatus() {
  const cfg = await getDiscConfig();
  const cands = Object.values(await getCandidates());
  const runs = Object.values(await getRuns()).sort((a, b) => String(b.id).localeCompare(String(a.id)));
  const counts = {};
  for (const c of cands) counts[c.status] = (counts[c.status] || 0) + 1;
  return {
    enabled: !!cfg.enabled, armable: discConfigArmable(cfg),
    perRunCap: cfg.perRunCap, dailyCap: cfg.dailyCap, slotsPerRun: cfg.slotsPerRun,
    planCount: (cfg.plan || []).length, plan: cfg.plan || [], weights: cfg.weights,
    candidateCount: cands.length, counts,
    callsToday: await getDayCalls(utcDay(new Date())),
    lastRun: runs[0] || null,
  };
}

export async function listRankedCandidates(limit = 50) {
  const cands = Object.values(await getCandidates());
  return cands
    .sort((a, b) => (b.score || 0) - (a.score || 0) || String(a.placeId).localeCompare(String(b.placeId)))
    .slice(0, Math.max(1, Math.min(200, limit | 0)))
    .map((c) => ({
      placeId: c.placeId, name: c.name, city: c.city, state: c.state, trade: c.slotTrade,
      webStatus: c.webStatus, rating: c.rating, reviews: c.reviews,
      status: c.status, score: c.score || 0, parts: c.parts || {},
      excludeReason: c.excludeReason || '', lastSeenAt: c.lastSeenAt || '',
      discoveredAt: c.discoveredAt || '', queries: (c.queries || []).length,
    }));
}

export async function listRuns(limit = 10) {
  const runs = Object.values(await getRuns()).sort((a, b) => String(b.id).localeCompare(String(a.id)));
  return runs.slice(0, Math.max(1, Math.min(50, limit | 0)));
}

export async function listCalls(limit = 50) {
  const calls = Object.values(await getCallLedger()).sort((a, b) => String(b.reservedAt).localeCompare(String(a.reservedAt)));
  return calls.slice(0, Math.max(1, Math.min(200, limit | 0)))
    .map((c) => ({ callId: c.callId, runId: c.runId, day: c.day, page: c.page, slotFp: c.slotFp, reservedAt: c.reservedAt, outcome: c.outcome, completedAt: c.completedAt }));
}
