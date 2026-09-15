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
import { existingSlugs, getSite, slugify, summary, SITE_DEFAULT } from './sites.js';
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

const EFFECTS_KEY = (runId) => `ks:draft:effects:${runId}`; // hash placeId -> 'new'|'repair'
const RC_KEY = (runId) => `ks:draft:rc:${runId}`;            // string counter of 'new' effects

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

const APPLY_SCRIPT = `
-- draft_apply_v1
-- KEYS: 1=lease, 2=site body, 3=siteidx, 4=place index, 5=candidates hash, 6=effects hash, 7=run counter
-- ARGV: 1=owner, 2=placeId, 3=slug, 4=siteJSON, 5=indexJSON, 6=candidateJSON, 7=effectType, 8=runId, 9=draftsPerRun
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 'LEASE_LOST' end
local dp = tonumber(ARGV[9])
if not dp or dp ~= math.floor(dp) or dp <= 0 then return 'INVALID_CAP' end
local rcRaw = redis.call('GET', KEYS[7])
local rc = 0
if rcRaw then
  rc = tonumber(rcRaw)
  if not rc or rc ~= math.floor(rc) or rc < 0 then return 'CORRUPT_COUNTER' end
end
local existingSlug = redis.call('HGET', KEYS[4], ARGV[2])
if existingSlug then
  if ARGV[7] == 'new' then return {'EXISTING', existingSlug, 'new'} end
else
  if redis.call('GET', KEYS[2]) then return {'COLLISION', ARGV[3]} end
  if redis.call('HEXISTS', KEYS[3], ARGV[3]) == 1 then return {'COLLISION', ARGV[3]} end
end
if ARGV[7] == 'new' then
  if rc >= dp then return 'CAP_REACHED' end
  redis.call('INCR', KEYS[7])
  redis.call('HSET', KEYS[6], ARGV[2], 'new')
elseif ARGV[7] == 'repair' and existingSlug == ARGV[3] then
  if redis.call('HGET', KEYS[6], ARGV[2]) == false then
    redis.call('HSET', KEYS[6], ARGV[2], 'repair')
  end
end
redis.call('SET', KEYS[2], ARGV[4])
redis.call('HSET', KEYS[3], ARGV[3], ARGV[5])
redis.call('HSET', KEYS[4], ARGV[2], ARGV[3])
redis.call('HSET', KEYS[5], ARGV[2], ARGV[6])
return {'OK', ARGV[3], ARGV[7]}`;

const LINK_SCRIPT = `
-- draft_link_v1
-- KEYS: 1=lease, 2=place index, 3=candidates hash
-- ARGV: 1=owner, 2=placeId, 3=slug, 4=candidateJSON
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 'LEASE_LOST' end
local existing = redis.call('HGET', KEYS[2], ARGV[2])
if existing and existing ~= ARGV[3] then return {'MAPPING_CONFLICT', existing} end
redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
redis.call('HSET', KEYS[3], ARGV[2], ARGV[4])
return 'OK'`;

const CANDIDATE_UPDATE_SCRIPT = `
-- draft_candidate_update_v1
-- KEYS: 1=lease, 2=candidates hash
-- ARGV: 1=owner, 2=placeId, 3=candidateJSON
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 'LEASE_LOST' end
redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
return 'OK'`;

const REPAIR_INDEX_SCRIPT = `
-- draft_repair_index_v1
-- KEYS: 1=lease, 2=siteidx
-- ARGV: 1=owner, 2=slug, 3=indexJSON
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 'LEASE_LOST' end
redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
return 'OK'`;

const RUN_STATUS_SCRIPT = `
-- draft_run_status_v1
-- KEYS: 1=lease, 2=runs hash
-- ARGV: 1=owner, 2=runId, 3=runJSON
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 'LEASE_LOST' end
redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
return 'OK'`;

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

function siteKey(slug) { return 'ks:site:' + slugify(slug); }

function parseApply(res) {
  if (res === 'LEASE_LOST') return { status: 'LEASE_LOST' };
  if (res === 'CAP_REACHED') return { status: 'CAP_REACHED' };
  if (res === 'INVALID_CAP') return { status: 'INVALID_CAP' };
  if (res === 'CORRUPT_COUNTER') return { status: 'CORRUPT_COUNTER' };
  if (!Array.isArray(res)) return { status: 'COLLISION' };
  if (res[0] === 'OK') return { status: 'OK', slug: res[1], effectType: res[2] };
  if (res[0] === 'EXISTING') return { status: 'EXISTING', slug: res[1], effectType: res[2] };
  if (res[0] === 'COLLISION') return { status: 'COLLISION', slug: res[1] };
  return { status: 'COLLISION' };
}

export async function _applyDraft({ owner, runId, draftsPerRun, placeId, slug, site, candidate, effectType }) {
  const indexEntry = JSON.stringify(summary(site));
  const res = await evalKeys(APPLY_SCRIPT,
    [LEASE_KEY, siteKey(slug), SITE_IDX_KEY, PLACE_IDX_KEY, CANDS_KEY, EFFECTS_KEY(runId), RC_KEY(runId)],
    [owner, placeId, slug, JSON.stringify(site), indexEntry, JSON.stringify(candidate), effectType, runId, draftsPerRun]);
  return parseApply(res);
}

export async function _linkDraft({ owner, placeId, slug, candidate }) {
  const res = await evalKeys(LINK_SCRIPT,
    [LEASE_KEY, PLACE_IDX_KEY, CANDS_KEY],
    [owner, placeId, slug, JSON.stringify(candidate)]);
  if (res === 'LEASE_LOST') return { status: 'LEASE_LOST' };
  if (Array.isArray(res) && res[0] === 'MAPPING_CONFLICT') return { status: 'MAPPING_CONFLICT', slug: res[1] };
  return { status: 'OK', slug };
}

export async function _updateCandidate({ owner, placeId, candidate }) {
  const res = await evalKeys(CANDIDATE_UPDATE_SCRIPT,
    [LEASE_KEY, CANDS_KEY],
    [owner, placeId, JSON.stringify(candidate)]);
  return res === 'OK';
}

export async function _repairSiteIndex({ owner, slug, site }) {
  const res = await evalKeys(REPAIR_INDEX_SCRIPT,
    [LEASE_KEY, SITE_IDX_KEY],
    [owner, slug, JSON.stringify(summary(site))]);
  return res === 'OK';
}

export async function _recordRunStatus({ owner, runId, run }) {
  const res = await evalKeys(RUN_STATUS_SCRIPT,
    [LEASE_KEY, RUNS_KEY],
    [owner, runId, JSON.stringify(run)]);
  return res === 'OK';
}

export async function _getRunEffects(runId) {
  const [effects, counter] = await Promise.all([
    cmd(['HGETALL', EFFECTS_KEY(runId)]),
    cmd(['GET', RC_KEY(runId)]),
  ]);
  return { effects: parseHash(effects), counter: Number(counter || 0) };
}

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

function makeSite(rec, placeId) {
  return {
    ...SITE_DEFAULT,
    ...rec,
    placeId,
    published: false,
    claimed: false,
    modules: ['P0'],
    source: 'draft-autonomy',
    leadId: placeId,
  };
}

function draftedCandidate(cand, slug, now) {
  return { ...cand, draftSlug: slug, draftedAt: now, draftStatus: 'drafted' };
}

/** Create or repair a draft for one candidate. Idempotent by placeId index. */
export async function _draftCandidate(cand, ctx, now) {
  const { taken, placeIndex, siteList, owner, runId, draftsPerRun } = ctx;
  const placeId = cand.placeId;

  // 1. Durably linked placeId -> slug. If the site body exists, we reconcile.
  const mappedSlug = placeIndex[placeId] || cand.draftSlug || null;
  if (mappedSlug) {
    const site = await getSite(mappedSlug);
    if (site && site.placeId === placeId) {
      // Ensure body/index/mapping/candidate linkage are atomically present
      // without consuming the new-draft cap. Records a durable 'repair' effect.
      const apply = await _applyDraft({
        owner, runId, draftsPerRun, placeId, slug: mappedSlug,
        site, candidate: draftedCandidate(cand, mappedSlug, now), effectType: 'repair',
      });
      if (apply.status === 'LEASE_LOST') return { action: 'lease_lost' };
      if (apply.status === 'CAP_REACHED') return { action: 'cap_reached' };
      if (apply.status === 'INVALID_CAP' || apply.status === 'CORRUPT_COUNTER') return { action: 'abort', reason: apply.status };
      placeIndex[placeId] = mappedSlug;
      taken.add(mappedSlug);
      return { slug: mappedSlug, action: 'linked', created: false };
    }
    if (!site) {
      // Mapping exists but body is missing and index cannot repair it:
      // recreate under the SAME canonical slug rather than minting slug-2.
      const lead = candidateToLead(cand);
      const rec = draftFromLead(lead, taken);
      if (rec) {
        const newSite = makeSite({ ...rec, slug: mappedSlug }, placeId);
        const apply = await _applyDraft({
          owner, runId, draftsPerRun, placeId, slug: mappedSlug,
          site: newSite, candidate: draftedCandidate(cand, mappedSlug, now), effectType: 'repair',
        });
        if (apply.status === 'LEASE_LOST') return { action: 'lease_lost' };
        if (apply.status === 'CAP_REACHED') return { action: 'cap_reached' };
        if (apply.status === 'INVALID_CAP' || apply.status === 'CORRUPT_COUNTER') return { action: 'abort', reason: apply.status };
        if (apply.status === 'OK' || apply.status === 'EXISTING') {
          placeIndex[placeId] = mappedSlug;
          taken.add(mappedSlug);
          return { slug: mappedSlug, action: 'drafted', created: true };
        }
        // COLLISION should not happen for a slug we are already mapped to; fall through.
      }
    }
    // Mapping stale or corrupted; fall through to atomic assignment.
  }

  // 2. Link an existing unclaimed unpublished site that matches strong identity
  // (e.g. a manually drafted site without a placeId mapping).
  const existingSite = matchExistingSite(cand, siteList);
  if (existingSite) {
    const link = await _linkDraft({ owner, placeId, slug: existingSite.slug, candidate: draftedCandidate(cand, existingSite.slug, now) });
    if (link.status === 'LEASE_LOST') return { action: 'lease_lost' };
    if (link.status === 'MAPPING_CONFLICT') {
      // placeId already maps to a different canonical slug; reconcile there.
      const canonical = link.slug;
      const canonicalSite = await getSite(canonical);
      if (canonicalSite) {
        const applyRepair = await _applyDraft({
          owner, runId, draftsPerRun, placeId, slug: canonical,
          site: canonicalSite, candidate: draftedCandidate(cand, canonical, now), effectType: 'repair',
        });
        if (applyRepair.status === 'LEASE_LOST') return { action: 'lease_lost' };
        if (applyRepair.status === 'CAP_REACHED') return { action: 'cap_reached' };
        if (applyRepair.status === 'INVALID_CAP' || applyRepair.status === 'CORRUPT_COUNTER') return { action: 'abort', reason: applyRepair.status };
        taken.add(canonical);
        return { slug: canonical, action: 'linked', created: false };
      }
      return { action: 'no_draft', created: false, reason: 'mapping conflict without site body' };
    }
    placeIndex[placeId] = existingSite.slug;
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
      const apply = await _applyDraft({
        owner, runId, draftsPerRun, placeId, slug,
        site: existingBody, candidate: draftedCandidate(cand, slug, now), effectType: 'repair',
      });
      if (apply.status === 'LEASE_LOST') return { action: 'lease_lost' };
      if (apply.status === 'CAP_REACHED') return { action: 'cap_reached' };
      if (apply.status === 'INVALID_CAP' || apply.status === 'CORRUPT_COUNTER') return { action: 'abort', reason: apply.status };
      placeIndex[placeId] = slug;
      taken.add(slug);
      return { slug, action: 'linked', created: false };
    }

    const site = makeSite(rec, placeId);
    const apply = await _applyDraft({
      owner, runId, draftsPerRun, placeId, slug,
      site, candidate: draftedCandidate(cand, slug, now), effectType: 'new',
    });
    if (apply.status === 'OK') {
      taken.add(slug);
      return { slug, action: 'drafted', created: true };
    }
    if (apply.status === 'LEASE_LOST') return { action: 'lease_lost' };
    if (apply.status === 'CAP_REACHED') return { action: 'cap_reached' };
    if (apply.status === 'INVALID_CAP' || apply.status === 'CORRUPT_COUNTER') return { action: 'abort', reason: apply.status };
    if (apply.status === 'EXISTING') {
      // Another worker committed first; reconcile to the canonical slug.
      const canonical = apply.slug;
      const existing = await getSite(canonical);
      if (existing) {
        const applyRepair = await _applyDraft({
          owner, runId, draftsPerRun, placeId, slug: canonical,
          site: existing, candidate: draftedCandidate(cand, canonical, now), effectType: 'repair',
        });
        if (applyRepair.status === 'LEASE_LOST') return { action: 'lease_lost' };
        if (applyRepair.status === 'CAP_REACHED') return { action: 'cap_reached' };
        if (applyRepair.status === 'INVALID_CAP' || applyRepair.status === 'CORRUPT_COUNTER') return { action: 'abort', reason: applyRepair.status };
        taken.add(canonical);
        return { slug: canonical, action: 'linked', created: false };
      }
      // Mapping points at a deleted/non-existent body. Re-create under the same
      // canonical slug rather than minting slug-2.
      rec = { ...rec, slug: canonical };
      const repairSite = makeSite(rec, placeId);
      const retry = await _applyDraft({
        owner, runId, draftsPerRun, placeId, slug: canonical,
        site: repairSite, candidate: draftedCandidate(cand, canonical, now), effectType: 'repair',
      });
      if (retry.status === 'OK') {
        taken.add(canonical);
        return { slug: canonical, action: 'drafted', created: true };
      }
      if (retry.status === 'LEASE_LOST') return { action: 'lease_lost' };
      if (retry.status === 'CAP_REACHED') return { action: 'cap_reached' };
      if (retry.status === 'INVALID_CAP' || retry.status === 'CORRUPT_COUNTER') return { action: 'abort', reason: retry.status };
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

    const { effects: priorEffects, counter: priorCounter } = await _getRunEffects(runId);

    const taken = await existingSlugs();

    // Ranked candidates sorted by score desc, stable tie-break by placeId.
    const ranked = Object.values(candMap)
      .filter((c) => c && c.status === 'ranked')
      .sort((a, b) => (b.score || 0) - (a.score || 0) || String(a.placeId).localeCompare(String(b.placeId)));

    const draftsPerRun = Math.max(0, Math.floor(cfg.draftsPerRun));
    let remaining = Math.max(0, draftsPerRun - priorCounter);
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
        // Re-persisting an unchanged exclusion every run is a write per
        // candidate per cron forever; only write when the verdict changed.
        if (cand.draftStatus !== 'excluded' || cand.draftExcludeReason !== 'below_min_score') {
          await _updateCandidate({ owner, placeId: cand.placeId, candidate: { ...cand, draftStatus: 'excluded', draftExcludeReason: 'below_min_score', draftExcludeDetail: 'candidate score below configured threshold' } });
        }
        run.skipped++;
        continue;
      }

      const ex = exclusionForDraft(cand, { suppressionState, siteList, accountList, placeIndex });
      if (ex) {
        if (cand.draftStatus !== 'excluded' || cand.draftExcludeReason !== ex.reason) {
          await _updateCandidate({ owner, placeId: cand.placeId, candidate: { ...cand, draftStatus: 'excluded', draftExcludeReason: ex.reason, draftExcludeDetail: ex.detail } });
        }
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
      const result = await _draftCandidate(cand, { taken, placeIndex, siteList, owner, runId, draftsPerRun }, now);
      if (result.action === 'lease_lost') {
        leaseLost = true;
        run.stopReason = 'lease_lost';
        break;
      }
      if (result.action === 'cap_reached') {
        run.capStop = 'drafts_per_run_cap';
        break;
      }
      if (result.action === 'abort') {
        run.status = 'failed';
        run.stopReason = result.reason;
        run.error = 'fatal: ' + result.reason;
        run.finishedAt = clock().toISOString();
        await _recordRunStatus({ owner, runId, run }).catch(() => {});
        return { ran: true, reason: 'failed', run, drafts: 0 };
      }
      if (result.created) {
        run.drafted++;
        remaining--;
      } else if (result.action === 'linked') {
        run.linked++;
        // Repairs do not consume the new-draft cap.
      } else {
        run.skipped++;
      }
    }

    run.status = leaseLost ? 'failed' : 'completed';
    run.finishedAt = clock().toISOString();
    if (leaseLost) {
      run.error = 'lease lost during run';
      await _recordRunStatus({ owner, runId, run }).catch(() => {});
      return { ran: true, reason: 'failed', run, drafts: 0 };
    }

    // Final lease check before declaring completion.
    if (!(await _checkLease(owner))) {
      run.status = 'failed';
      run.stopReason = 'lease_lost';
      run.error = 'lease lost before completion';
      await _recordRunStatus({ owner, runId, run }).catch(() => {});
      return { ran: true, reason: 'failed', run, drafts: 0 };
    }

    if (!(await _completeRun({ owner, runId, run: { ...run, status: 'completed' } }))) {
      run.status = 'failed';
      run.stopReason = 'lease_lost';
      run.error = 'lease lost at completion';
      await _recordRunStatus({ owner, runId, run }).catch(() => {});
      return { ran: true, reason: 'failed', run, drafts: 0 };
    }
    run.status = 'completed';
    return { ran: true, reason: 'completed', run, drafts: run.drafted + run.linked };
  } catch (e) {
    run.error = String(e && e.message || e).slice(0, 300);
    run.finishedAt = clock().toISOString();
    await _recordRunStatus({ owner, runId, run }).catch(() => {});
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
