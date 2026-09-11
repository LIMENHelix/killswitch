// K4 — bounded autonomous prospect discovery and ranking. UPSTREAM ONLY.
//
// This module discovers businesses via Google Places, gives each one a durable
// canonical identity (the Google Place ID, which the manual finder used to
// discard), reconciles it against existing Killswitch state, scores it with a
// pure deterministic function, and STOPS. It contacts nobody: no mailer, no
// Lob, no Resend outreach, no voice agent, no site drafting, no publishing.
// The import list below is the whole safety argument — kv, web-presence,
// suppression, sites, store. Nothing outbound lives in this graph.
//
// Everything is gated by a config that DEFAULTS OFF (ks:disc:cfg, same pattern
// as the postcard autopilot's ks:autopilot). An absent or malformed config can
// never enable discovery, and any missing cap fails the run closed with zero
// Places calls. Production caps, geography, trades and ranking policy are
// CHRIS DECISIONS: this file ships no production values.

import { cmd, parseHash } from './kv.js';
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
    if (e && e.name === 'TimeoutError') throw new Error('places timeout after ' + FETCH_TIMEOUT_MS + 'ms');
    if (e && e.name === 'AbortError') throw new Error('places timeout after ' + FETCH_TIMEOUT_MS + 'ms');
    throw new Error('places request failed: ' + String(e && e.message || e).slice(0, 160));
  }
  if (!r.ok) throw new Error('places ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const j = await r.json().catch(() => null);
  if (!j || !Array.isArray(j.places)) throw new Error('places malformed response');
  return j;
}

// ---- config (defaults OFF; arming requires explicit caps + plan) ----

const CFG_KEY = 'ks:disc:cfg';
export const DISC_DEFAULT = {
  enabled: false,
  perRunCap: 0,     // max Places CALLS one run may make
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
 *  refused, so a malformed save can never arm spend. */
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
const CURSOR_KEY = 'ks:disc:cursor';   // blob: {index, updatedAt, failures}
const LEASE_KEY = 'ks:disc:lease';     // SET NX EX — one effective run at a time
const DAY_KEY = (d) => 'ks:disc:day:' + d;
const SLOT_FAILURE_GIVEUP = 3;         // consecutive failures before a slot is skipped for good

const clean = (v, n = 200) => String(v == null ? '' : v).trim().slice(0, n);
const norm = (v) => clean(v).toLowerCase().replace(/[^a-z0-9]/g, '');
const dayStamp = (now = new Date()) => now.toISOString().slice(0, 10).replace(/-/g, '');

export async function getCandidates() { return parseHash(await cmd(['HGETALL', CANDS_KEY])); }
export async function getRuns() { return parseHash(await cmd(['HGETALL', RUNS_KEY])); }

async function getCursor() {
  const v = await cmd(['GET', CURSOR_KEY]);
  if (!v) return { index: 0, updatedAt: '', failures: {} };
  try { return { index: 0, updatedAt: '', failures: {}, ...JSON.parse(v) }; } catch { return { index: 0, updatedAt: '', failures: {} }; }
}
async function saveCursor(c) { await cmd(['SET', CURSOR_KEY, JSON.stringify(c)]); }

async function getDayCalls(d) {
  const v = await cmd(['GET', DAY_KEY(d)]);
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
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

// ---- candidate upsert ----

// Pure merge — the caller persists once. `existing` is the stored record (or
// null); identity fields (placeId, discoveredAt, firstRunId, query history)
// are stable, factual snapshot fields refresh, lastSeen/lastRun always move.
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
      ...norm0,                       // latest factual snapshot wins
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
 * auth, enabled flag and armability; this function re-checks armability
 * anyway, because a run that can spend money re-verifies every gate itself.
 *
 * Invariants: zero Places calls when anything is missing; same run id never
 * does external work twice; cursor advances only on explicit success; a lease
 * prevents overlapping executions from double-processing a slot.
 */
export async function runDiscovery({ fetchFn = fetch, now = new Date() } = {}) {
  // Preview deploys share the production Places key. The KV layer namespaces
  // preview data away from live customers, but a Places call from a preview
  // would still be REAL spend — so preview runs nothing, ever.
  if (process.env.VERCEL_ENV === 'preview') return { ran: false, reason: 'preview_disabled', calls: 0 };
  const key = process.env.GOOGLE_PLACES_API_KEY;
  const cfg = await getDiscConfig();
  if (!cfg.enabled) return { ran: false, reason: 'disabled', calls: 0 };
  if (!key) return { ran: false, reason: 'no_places_key', calls: 0 };
  if (!discConfigArmable(cfg)) return { ran: false, reason: 'incomplete_config', calls: 0 };

  // Overlap guard: one effective run at a time. A crashed holder's lease
  // expires and the next invocation resumes cleanly.
  const lease = await cmd(['SET', LEASE_KEY, 'held', 'NX', 'EX', 600]);
  if (lease !== 'OK') return { ran: false, reason: 'lease_held', calls: 0 };

  const d = dayStamp(now);
  const run = {
    id: '', slot: null, status: 'failed', startedAt: now.toISOString(), finishedAt: '',
    calls: 0, raw: 0, newCount: 0, updatedCount: 0, excludedCount: 0, rankedCount: 0,
    capStop: '', error: '',
  };

  try {
    const cursor = await getCursor();
    let callsToday = await getDayCalls(d);
    const [suppressionState, siteList] = await Promise.all([getSuppressionState(), listSites()]);
    const weights = cfg.weights;
    // Loaded once per run: the lease guarantees no other run interleaves, so
    // the in-memory map is authoritative for the whole slot.
    const candMap = await getCandidates();

    let newSlots = Math.max(1, Math.floor(cfg.slotsPerRun));
    let sawCompleted = false;
    // Catch-up scans at most the whole plan once: if every slot is already
    // done, every iteration is a `continue`, so without this bound a fully
    // completed plan would spin forever.
    let scans = cfg.plan.length;

    while (newSlots > 0 && scans-- > 0) {
      const slot = cfg.plan[cursor.index % cfg.plan.length];
      const slotKey = clean(slot.trade, 60) + '|' + clean(slot.city, 80);
      const runId = 'run-' + d + '-' + (cursor.index % cfg.plan.length);
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
      let pageToken = null, pages = 0;

      try {
        do {
          if (run.calls >= cfg.perRunCap) { run.capStop = 'per_run_cap'; break; }
          if (callsToday >= cfg.dailyCap) { run.capStop = 'daily_cap'; break; }
          const res = await placesSearch({ query, key, pageToken, fetchFn });
          run.calls++; callsToday++;
          pages++;
          run.raw += (res.places || []).length;

          for (const place of res.places || []) {
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

          pageToken = run.capStop ? null : res.nextPageToken;
          if (pageToken && pages < MAX_PAGES_PER_SLOT) await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
          else pageToken = null;
        } while (pageToken);

        run.status = 'completed';
        run.finishedAt = new Date().toISOString();
        await cmd(['HSET', RUNS_KEY, runId, JSON.stringify(run)]);
        // Success semantics: the slot is done — even when a cap stopped it
        // early, a capped partial slot is recorded truthfully with capStop and
        // the plan moves on (bounded spend wins over full coverage). ONLY
        // completed runs advance the cursor.
        cursor.index = (cursor.index + 1) % cfg.plan.length;
        delete cursor.failures[slotKey];
      } catch (e) {
        run.error = String(e && e.message || e).slice(0, 300);
        run.finishedAt = new Date().toISOString();
        await cmd(['HSET', RUNS_KEY, runId, JSON.stringify(run)]).catch(() => {});
        // A failed slot does NOT advance the cursor (no false advance on
        // timeout/upstream failure — the next invocation retries it). After
        // SLOT_FAILURE_GIVEUP consecutive failures the slot is treated as
        // permanently bad and skipped so one broken query cannot stall the
        // whole plan forever.
        cursor.failures[slotKey] = (cursor.failures[slotKey] || 0) + 1;
        if (cursor.failures[slotKey] >= SLOT_FAILURE_GIVEUP) {
          cursor.index = (cursor.index + 1) % cfg.plan.length;
          delete cursor.failures[slotKey];
        }
        break;
      }
    }

    cursor.updatedAt = new Date().toISOString();
    await saveCursor(cursor);
    await cmd(['SET', DAY_KEY(d), String(callsToday)]);
    const reason = run.id ? (run.status === 'completed' ? 'completed' : 'failed') : (sawCompleted ? 'caught_up' : 'no_work');
    return { ran: run.id !== '', reason, run, calls: run.calls };
  } finally {
    await cmd(['DEL', LEASE_KEY]).catch(() => {});
  }
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
    callsToday: await getDayCalls(dayStamp()),
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
