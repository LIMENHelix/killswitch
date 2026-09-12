// K5 — autonomous unpublished site drafting from ranked K4 candidates.
//
// Connects the hardened K4 discovery pipeline to the EXISTING draft-site
// machinery. A ranked candidate is re-checked for current eligibility, then
// turned into one factual UNPUBLISHED site draft via draftFromLead. Nothing
// is contacted, published, or sold.
//
// HARD BOUNDARIES, by construction of what this file imports:
//   - no mailer, no Lob, no outbound email service, no voice agent, no SMS
//   - no site-publication helper / customer onboarding
//   - no payment module
// A candidate reaching "drafted" is the end of the line for K5.
//
// IDENTITY. The K4 placeId is the canonical candidate identity. A durable
// placeId -> slug index makes retries and concurrent workers idempotent:
// the same placeId can never produce two drafts.
//
// AUTONOMY DEFAULTS OFF. The K5 config (ks:draft:cfg) is separate from the
// K4 discovery config. Enabling discovery does not enable drafting. Arming
// requires explicit owner action through api/admin.js action:draft-setconfig.

import crypto from 'node:crypto';
import { cmd, parseHash, keyFor } from './kv.js';
import { draftFromLead } from './draft-site.js';
import { existingSlugs, getSite, repairSiteIndex, slugify, summary, upsertSite, SITE_DEFAULT } from './sites.js';
import { getSuppressionState, matchSuppression } from './suppression.js';
import { getAccounts } from './store.js';
import { getCandidates, getRuns as getDiscRuns } from './discovery.js';

// ---- config (defaults OFF; arming requires explicit draftsPerRun) ----

const CFG_KEY = 'ks:draft:cfg';
export const DRAFT_DEFAULT = {
  enabled: false,
  draftsPerRun: 0,   // max drafts one run may create
  minScore: 0,       // minimum K4 score to be considered (0 = all ranked)
};

export async function getDraftConfig() {
  const v = await cmd(['GET', CFG_KEY]);
  if (!v) return { ...DRAFT_DEFAULT };
  try { return { ...DRAFT_DEFAULT, ...JSON.parse(v) }; } catch { return { ...DRAFT_DEFAULT }; }
}

export async function saveDraftConfig(cfg) {
  await cmd(['SET', CFG_KEY, JSON.stringify(cfg)]);
  return cfg;
}

export function draftConfigArmable(cfg) {
  const c = cfg || {};
  return !!(c.enabled)
    && Number(c.draftsPerRun) > 0
    && Number(c.minScore) >= 0;
}

/** Validate an operator patch; returns {config} or {error}. */
export function validateDraftConfigPatch(cur, body) {
  const next = { ...cur };
  if (body.enabled !== undefined) next.enabled = !!body.enabled;
  if (body.draftsPerRun !== undefined) next.draftsPerRun = Math.max(0, Math.floor(Number(body.draftsPerRun) || 0));
  if (body.minScore !== undefined) next.minScore = Math.max(0, Number(body.minScore) || 0);
  if (next.enabled && !draftConfigArmable(next)) {
    return { error: 'incomplete_config', message: 'Enabling autonomous drafting requires draftsPerRun > 0. Nothing was saved.' };
  }
  return { config: next };
}

// ---- durable state ----

const CANDS_KEY = 'ks:disc:cands';       // hash: placeId -> candidate JSON (shared with K4)
const RUNS_KEY = 'ks:draft:runs';        // hash: runId -> draft run ledger JSON
const PLACE_IDX_KEY = 'ks:draft:place';  // hash: placeId -> slug (idempotent draft identity)
const SITE_IDX_KEY = 'ks:siteidx';       // hash: slug -> summary (shared with lib/sites.js)
const LEASE_KEY = 'ks:draft:lease';      // owned value: compare-and-renew/release only
const LEASE_TTL_MS = 120000;

const clean = (v, n = 200) => String(v == null ? '' : v).trim().slice(0, n);
const norm = (v) => clean(v).toLowerCase().replace(/[^a-z0-9]/g, '');
const normPhone = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 7 ? d.slice(-10) : ''; };
const utcDay = (d) => d.toISOString().slice(0, 10);

export async function getDraftRuns() { return parseHash(await cmd(['HGETALL', RUNS_KEY])); }
export async function getPlaceIndex() { return parseHash(await cmd(['HGETALL', PLACE_IDX_KEY])); }

// ---- atomic primitives (Lua/EVAL) ----
// kv.js's command scoper only rewrites args[1]; EVAL keys live at args[3..], so we
// pre-scope them here, matching the pattern already proven in lib/discovery.js.
async function evalKeys(script, keys, args) {
  const scoped = keys.map((k) => keyFor(k));
  return cmd(['EVAL', script, String(scoped.length), ...scoped, ...args.map((a) => String(a))]);
}

const LEASE_RENEW_SCRIPT = `
-- draft_lease_renew_v1
-- KEYS: 1=lease. ARGV: 1=owner 2=ttlMs. Renew only if still ours.
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PSETEX', KEYS[1], ARGV[2], ARGV[1])
else
  return 'LOST'
end`;

const LEASE_RELEASE_SCRIPT = `
-- draft_lease_release_v1
-- KEYS: 1=lease. ARGV: 1=owner. Release only if still ours.
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end`;

const COMPLETE_SCRIPT = `
-- draft_complete_v1
-- KEYS: 1=lease, 2=runs hash. ARGV: 1=owner 2=runId 3=runJSON
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 'LEASE_LOST' end
redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
return 'COMPLETED'`;

const COMMIT_SCRIPT = `
-- draft_commit_v1
-- KEYS: 1=site body, 2=siteidx, 3=place index, 4=candidates hash
-- ARGV: 1=placeId 2=slug 3=siteJSON 4=indexJSON 5=candidateJSON
local existingSlug = redis.call('HGET', KEYS[3], ARGV[1])
if existingSlug then return {'EXISTING', existingSlug} end
if redis.call('GET', KEYS[1]) then return {'COLLISION', ARGV[2]} end
if redis.call('HEXISTS', KEYS[2], ARGV[2]) == 1 then return {'COLLISION', ARGV[2]} end
redis.call('SET', KEYS[1], ARGV[3])
redis.call('HSET', KEYS[2], ARGV[2], ARGV[4])
redis.call('HSET', KEYS[3], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[4], ARGV[1], ARGV[5])
return {'OK', ARGV[2]}`;

async function acquireLease(owner, ttlMs = LEASE_TTL_MS) {
  const v = await cmd(['SET', LEASE_KEY, owner, 'NX', 'PX', ttlMs]);
  return v === 'OK';
}
export async function _renewLease(owner, ttlMs = LEASE_TTL_MS) {
  const v = await evalKeys(LEASE_RENEW_SCRIPT, [LEASE_KEY], [owner, ttlMs]);
  return v === 'OK';
}
export async function _checkLease(owner) {
  const v = await cmd(['GET', LEASE_KEY]);
  return v === owner;
}
export async function _releaseLease(owner) {
  const v = await evalKeys(LEASE_RELEASE_SCRIPT, [LEASE_KEY], [owner]);
  return v === 1 || v === '1';
}
export async function _completeRun({ owner, runId, run }) {
  const status = await evalKeys(COMPLETE_SCRIPT, [LEASE_KEY, RUNS_KEY], [owner, runId, JSON.stringify(run)]);
  return status === 'COMPLETED';
}

/**
 * Atomically commit one K5 draft: site body, site index, place->slug mapping,
 * and candidate linkage. Returns {status, slug} where status is OK, EXISTING,
 * or COLLISION. OK/EXISTING mean one canonical site record exists for placeId.
 */
// Exported for test instrumentation only.
export async function _commitDraft({ placeId, slug, site, candidate }) {
  const indexEntry = JSON.stringify(summary(site));
  const res = await evalKeys(COMMIT_SCRIPT,
    [siteKey(slug), SITE_IDX_KEY, PLACE_IDX_KEY, CANDS_KEY],
    [placeId, slug, JSON.stringify(site), indexEntry, JSON.stringify(candidate)]);
  if (!Array.isArray(res)) return { status: 'COLLISION', slug };
  return { status: res[0], slug: res[1] };
}

function siteKey(slug) { return 'ks:site:' + slugify(slug); }

// ---- identity / reconciliation ----

/**
 * Strong reconciliation before any draft mutation. Returns null if eligible,
 * or {reason, detail} if not. Uses exact normalized signals only:
 * - suppression match
 * - existing claimed/customer site by exact name+city
 * - existing site/account by normalized phone
 * - ambiguous identity (multiple matches)
 * - missing canonical placeId
 * - missing business name
 * - non-operational
 * - already drafted by placeId index or candidate state
 */
export function exclusionForDraft(cand, {
  suppressionState, siteList, accountList, placeIndex,
}) {
  if (!cand.placeId) return { reason: 'missing_identity', detail: 'candidate has no canonical placeId' };
  if (!clean(cand.name)) return { reason: 'missing_identity', detail: 'candidate has no business name' };
  if (cand.businessStatus && cand.businessStatus !== 'OPERATIONAL') {
    return { reason: 'not_operational', detail: 'business is not operational' };
  }

  const sup = matchSuppression({
    phone: cand.phone,
    street: cand.street, city: cand.city, state: cand.state, zip: cand.zip,
  }, suppressionState || {});
  if (sup) return { reason: 'suppressed', detail: 'do-not-contact record matched' };

  const cn = norm(cand.name), cc = norm(cand.city);
  const phone = normPhone(cand.phone);

  // Exact name + city match against existing sites.
  // Unclaimed unpublished drafts are eligible for linkage; claimed or published
  // sites are excluded so K5 never creates a duplicate public page.
  if (cn && cc) {
    const nameCityHits = (siteList || []).filter((s) => norm(s.business) === cn && norm(s.city) === cc);
    if (nameCityHits.length > 1) return { reason: 'ambiguous_identity', detail: 'multiple existing sites share this name and city' };
    if (nameCityHits.length === 1) {
      const s = nameCityHits[0];
      if (s.claimed) return { reason: 'claimed_site', detail: 'a claimed customer site already exists' };
      if (s.published) return { reason: 'existing_site', detail: 'an existing published site already exists' };
      // fall through: unclaimed unpublished draft can be linked
    }
  }

  // Strong phone match against sites and accounts.
  if (phone) {
    const sitePhoneHits = (siteList || []).filter((s) => normPhone(s.phone) === phone);
    const accountPhoneHits = Object.values(accountList || {}).filter((a) => normPhone(a && a.phone) === phone);
    const allPhoneHits = sitePhoneHits.concat(accountPhoneHits);
    if (allPhoneHits.length > 1) return { reason: 'ambiguous_identity', detail: 'phone matches multiple records' };
    if (sitePhoneHits.length === 1) {
      const s = sitePhoneHits[0];
      if (s.claimed) return { reason: 'claimed_site', detail: 'phone matches a claimed customer site' };
      if (s.published) return { reason: 'existing_site', detail: 'phone matches an existing published site' };
      // fall through: unclaimed unpublished draft can be linked
    }
    if (accountPhoneHits.length === 1) {
      const a = accountPhoneHits[0];
      const isPaid = Array.isArray(a.plan) && a.plan.some((p) => p && p !== 'P0');
      return { reason: isPaid ? 'paid_customer' : 'current_customer', detail: 'phone matches an existing account' };
    }
  }

  return null;
}

// ---- candidate -> lead adapter ----

export function candidateToLead(cand) {
  return {
    id: cand.placeId,
    name: cand.name,
    trade: cand.slotTrade || cand.category || '',
    city: cand.city || '',
    state: cand.state || '',
    street: cand.street || '',
    zip: cand.zip || '',
    phone: cand.phone || '',
    hours: Array.isArray(cand.hours) ? cand.hours.filter((h) => h && h.d && h.h).slice(0, 7) : [],
  };
}

// ---- draft creation ----

async function writeCandidate(placeId, patch) {
  const raw = await cmd(['HGET', CANDS_KEY, placeId]);
  let cur = null;
  try { cur = raw ? JSON.parse(raw) : null; } catch { cur = null; }
  if (!cur) return null;
  const next = { ...cur, ...patch };
  await cmd(['HSET', CANDS_KEY, placeId, JSON.stringify(next)]);
  return next;
}

function matchExistingSite(cand, siteList) {
  const cn = norm(cand.name), cc = norm(cand.city);
  const phone = normPhone(cand.phone);
  for (const s of siteList || []) {
    if (s.claimed || s.published) continue;
    if (cn && cc && norm(s.business) === cn && norm(s.city) === cc) return s;
    if (phone && normPhone(s.phone) === phone) return s;
  }
  return null;
}

/** Create or repair a draft for one candidate. Idempotent by placeId index. */
export async function _draftCandidate(cand, ctx, now) {
  const { taken, placeIndex, siteList } = ctx;
  const placeId = cand.placeId;

  // 1. Durably linked placeId -> slug. If the site body exists, we reconcile.
  const mappedSlug = placeIndex[placeId] || cand.draftSlug || null;
  if (mappedSlug) {
    let site = await getSite(mappedSlug);
    if (!site) {
      // Mapping exists but body is missing: repair from index if possible.
      await repairSiteIndex(mappedSlug);
      site = await getSite(mappedSlug);
    }
    if (site && site.placeId === placeId) {
      await cmd(['HSET', PLACE_IDX_KEY, placeId, mappedSlug]);
      placeIndex[placeId] = mappedSlug;
      // Ensure the site index is repaired even if the body was already present.
      await repairSiteIndex(mappedSlug);
      await writeCandidate(placeId, { draftSlug: mappedSlug, draftedAt: now, draftStatus: 'drafted' });
      taken.add(mappedSlug);
      return { slug: mappedSlug, action: 'linked', created: false };
    }
    if (!site) {
      // Mapping exists but body is missing and index cannot repair it:
      // recreate under the SAME canonical slug rather than minting slug-2.
      const lead = candidateToLead(cand);
      const rec = draftFromLead(lead, taken);
      if (rec) {
        const newSite = {
          ...SITE_DEFAULT,
          ...rec,
          slug: mappedSlug,
          placeId,
          published: false,
          claimed: false,
          modules: ['P0'],
          source: 'draft-autonomy',
          leadId: placeId,
        };
        await upsertSite(newSite);
        await cmd(['HSET', PLACE_IDX_KEY, placeId, mappedSlug]);
        placeIndex[placeId] = mappedSlug;
        await writeCandidate(placeId, { draftSlug: mappedSlug, draftedAt: now, draftStatus: 'drafted' });
        taken.add(mappedSlug);
        return { slug: mappedSlug, action: 'drafted', created: true };
      }
    }
    // Mapping stale or corrupted; fall through to atomic assignment.
  }

  // 2. Link an existing unclaimed unpublished site that matches strong identity
  // (e.g. a manually drafted site without a placeId mapping).
  const existingSite = matchExistingSite(cand, siteList);
  if (existingSite) {
    await cmd(['HSET', PLACE_IDX_KEY, placeId, existingSite.slug]);
    placeIndex[placeId] = existingSite.slug;
    await writeCandidate(placeId, { draftSlug: existingSite.slug, draftedAt: now, draftStatus: 'drafted' });
    taken.add(existingSite.slug);
    return { slug: existingSite.slug, action: 'linked', created: false };
  }

  // 3. Atomically reserve a canonical slug and commit the draft records.
  const lead = candidateToLead(cand);
  let rec = draftFromLead(lead, taken);
  while (rec) {
    const slug = rec.slug;

    // Fast check for a body already present at this slug with the same placeId.
    // This covers older partial writes before the atomic commit existed.
    const existingBody = await getSite(slug);
    if (existingBody && existingBody.placeId === placeId) {
      await cmd(['HSET', PLACE_IDX_KEY, placeId, slug]);
      placeIndex[placeId] = slug;
      await repairSiteIndex(slug);
      await writeCandidate(placeId, { draftSlug: slug, draftedAt: now, draftStatus: 'drafted' });
      taken.add(slug);
      return { slug, action: 'linked', created: false };
    }

    const site = {
      ...SITE_DEFAULT,
      ...rec,
      placeId,
      published: false,
      claimed: false,
      modules: ['P0'],
      source: 'draft-autonomy',
      leadId: placeId,
    };

    const commit = await _commitDraft({ placeId, slug, site, candidate: { ...cand, draftSlug: slug, draftedAt: now, draftStatus: 'drafted' } });
    if (commit.status === 'OK') {
      taken.add(slug);
      return { slug, action: 'drafted', created: true };
    }
    if (commit.status === 'EXISTING') {
      // Another worker committed first; reconcile to the canonical slug.
      const canonical = commit.slug;
      let existing = await getSite(canonical);
      if (!existing) {
        // Mapping exists but body is missing: finish the same canonical slug.
        await repairSiteIndex(canonical);
        existing = await getSite(canonical);
      }
      if (existing) {
        await writeCandidate(placeId, { draftSlug: canonical, draftedAt: now, draftStatus: 'drafted' });
        taken.add(canonical);
        return { slug: canonical, action: 'linked', created: false };
      }
      // Mapping points at a deleted/non-existent body. Re-create under the same
      // canonical slug rather than minting slug-2.
      rec = { ...rec, slug: canonical };
      const site = {
        ...SITE_DEFAULT,
        ...rec,
        placeId,
        published: false,
        claimed: false,
        modules: ['P0'],
        source: 'draft-autonomy',
        leadId: placeId,
      };
      const retry = await _commitDraft({ placeId, slug: canonical, site, candidate: { ...cand, draftSlug: canonical, draftedAt: now, draftStatus: 'drafted' } });
      if (retry.status === 'OK') {
        taken.add(canonical);
        return { slug: canonical, action: 'drafted', created: true };
      }
      // Should not happen; fall through to try a fresh slug.
      rec = draftFromLead(lead, taken);
      continue;
    }
    // COLLISION: slug taken by a different record. Try the next candidate slug.
    rec = draftFromLead(lead, taken);
  }

  return { action: 'no_draft', created: false, reason: 'draftFromLead returned null' };
}

// ---- the bounded run ----

/**
 * One bounded autonomous drafting run. Caller (the cron handler) has already
 * checked auth; this function re-checks every gate itself.
 *
 * Options are injection seams for tests: clock (returns Date).
 */
export async function runDraftAutonomy({ clock = () => new Date(), owner: injectedOwner, beforeCandidate } = {}) {
  if (process.env.VERCEL_ENV === 'preview') return { ran: false, reason: 'preview_disabled', drafts: 0 };
  const cfg = await getDraftConfig();
  if (!cfg.enabled) return { ran: false, reason: 'disabled', drafts: 0 };
  if (!draftConfigArmable(cfg)) return { ran: false, reason: 'incomplete_config', drafts: 0 };

  const owner = injectedOwner || 'own-' + crypto.randomBytes(8).toString('hex');
  if (!(await acquireLease(owner, LEASE_TTL_MS))) return { ran: false, reason: 'lease_held', drafts: 0 };

  const runId = 'draft-run-' + utcDay(clock()).replace(/-/g, '');
  const run = {
    id: runId,
    status: 'failed',
    startedAt: clock().toISOString(),
    finishedAt: '',
    considered: 0,
    eligible: 0,
    drafted: 0,
    linked: 0,
    skipped: 0,
    capStop: '',
    stopReason: '',
    error: '',
  };

  try {
    const prior = await cmd(['HGET', RUNS_KEY, runId]);
    if (prior) {
      const p = JSON.parse(prior);
      if (p.status === 'completed') return { ran: false, reason: 'caught_up', drafts: 0 };
    }

    const [suppressionState, siteList, accountList, candMap, placeIndex] = await Promise.all([
      getSuppressionState(),
      // load full site summaries for reconciliation
      (async () => {
        const idx = parseHash(await cmd(['HGETALL', SITE_IDX_KEY]));
        return Object.keys(idx).map((slug) => ({ slug, ...idx[slug] }));
      })(),
      getAccounts(),
      getCandidates(),
      getPlaceIndex(),
    ]);

    const taken = await existingSlugs();

    // Ranked candidates sorted by score desc, stable tie-break by placeId.
    const ranked = Object.values(candMap)
      .filter((c) => c && c.status === 'ranked')
      .sort((a, b) => (b.score || 0) - (a.score || 0) || String(a.placeId).localeCompare(String(b.placeId)));

    let remaining = Math.max(0, Math.floor(cfg.draftsPerRun));
    let leaseLost = false;

    for (const cand of ranked) {
      if (remaining <= 0) { run.capStop = 'drafts_per_run_cap'; break; }

      if (beforeCandidate) await beforeCandidate();

      // Fence: stop if we are no longer the lease owner.
      if (!(await _checkLease(owner))) {
        leaseLost = true;
        run.stopReason = 'lease_lost';
        break;
      }

      run.considered++;

      if ((cand.score || 0) < cfg.minScore) {
        await writeCandidate(cand.placeId, { draftStatus: 'excluded', draftExcludeReason: 'below_min_score', draftExcludeDetail: 'candidate score below configured threshold' });
        run.skipped++;
        continue;
      }

      const ex = exclusionForDraft(cand, { suppressionState, siteList, accountList, placeIndex });
      if (ex) {
        await writeCandidate(cand.placeId, { draftStatus: 'excluded', draftExcludeReason: ex.reason, draftExcludeDetail: ex.detail });
        run.skipped++;
        continue;
      }
      run.eligible++;

      // Renew before mutation; if lost, stop.
      if (!(await _renewLease(owner, LEASE_TTL_MS))) {
        leaseLost = true;
        run.stopReason = 'lease_lost';
        break;
      }

      const now = clock().toISOString();
      const result = await _draftCandidate(cand, { taken, placeIndex, siteList }, now);
      if (result.created) {
        run.drafted++;
        remaining--;
      } else if (result.action === 'linked') {
        run.linked++;
        remaining--;
      } else {
        run.skipped++;
      }
    }

    run.status = leaseLost ? 'failed' : 'completed';
    run.finishedAt = clock().toISOString();
    if (leaseLost) {
      run.error = 'lease lost during run';
      // Best-effort fenced write; if we no longer own the lease this will be refused.
      await _completeRun({ owner, runId, run }).catch(() => {});
      return { ran: true, reason: 'failed', run, drafts: 0 };
    }

    // Final lease check before declaring completion.
    if (!(await _checkLease(owner))) {
      run.status = 'failed';
      run.stopReason = 'lease_lost';
      run.error = 'lease lost before completion';
      await _completeRun({ owner, runId, run }).catch(() => {});
      return { ran: true, reason: 'failed', run, drafts: 0 };
    }

    if (!(await _completeRun({ owner, runId, run: { ...run, status: 'completed' } }))) {
      run.status = 'failed';
      run.stopReason = 'lease_lost';
      run.error = 'lease lost at completion';
      await cmd(['HSET', RUNS_KEY, runId, JSON.stringify(run)]).catch(() => {});
      return { ran: true, reason: 'failed', run, drafts: 0 };
    }
    run.status = 'completed';
    return { ran: true, reason: 'completed', run, drafts: run.drafted + run.linked };
  } catch (e) {
    run.error = String(e && e.message || e).slice(0, 300);
    run.finishedAt = clock().toISOString();
    await cmd(['HSET', RUNS_KEY, runId, JSON.stringify(run)]).catch(() => {});
    return { ran: true, reason: 'failed', run, drafts: 0 };
  } finally {
    await _releaseLease(owner).catch(() => {});
  }
}

// ---- operator read model ----

export async function draftAutonomyStatus() {
  const cfg = await getDraftConfig();
  const runs = Object.values(await getDraftRuns()).sort((a, b) => String(b.id).localeCompare(String(a.id)));
  const cands = Object.values(await getCandidates());
  const drafted = cands.filter((c) => c && c.draftSlug).length;
  const ranked = cands.filter((c) => c && c.status === 'ranked').length;
  return {
    enabled: !!cfg.enabled,
    armable: draftConfigArmable(cfg),
    draftsPerRun: cfg.draftsPerRun,
    minScore: cfg.minScore,
    rankedCount: ranked,
    draftedCount: drafted,
    lastRun: runs[0] || null,
  };
}

export async function listDraftRuns(limit = 10) {
  const runs = Object.values(await getDraftRuns()).sort((a, b) => String(b.id).localeCompare(String(a.id)));
  return runs.slice(0, Math.max(1, Math.min(50, limit | 0)));
}
