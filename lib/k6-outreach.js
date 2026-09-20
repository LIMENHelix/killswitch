// K6 — autonomous prospect outreach control plane.
//
// This module is the durable config + run orchestration for outbound prospect
// contact. It does not send anything itself; it delegates to channel adapters
// (currently only postcard via lib/mailer.js).
//
// K6 defaults OFF. Arming requires explicit owner action and valid caps.

import crypto from 'node:crypto';
import { checkProspectEligibility } from './outreach-eligibility.js';
import {
  acquireLease, renewLease, checkLease, releaseLease,
  reserveEffect, updateEffect, recordRun, listPendingEffects, getStatusCounts, STATUS,
  makeEffectId, makeIdempotencyKey,
} from './outreach-effects.js';
import { sendPostcard, inQueue, hasAddr, lobKeyMode, senderConfigPresence } from './mailer.js';
import { getLeads, getLeadMeta, getAccounts } from './store.js';
import { getCandidates } from './discovery.js';
import { candidateToLead } from './draft-autonomy.js';
import { getSuppressionState } from './suppression.js';
import { matchLegacyLead } from './lead-match.js';
import { listSites, siteSlugsByEmail, getSite } from './sites.js';
import { cmd } from './kv.js';

const MAX_ATTEMPTS = 3;

export const CFG_KEY = 'ks:outreach:cfg';

// Only the postcard transport exists in this PR. Arming any other channel is a
// config error, not a silent no-op.
export const SUPPORTED_CHANNELS = ['postcard'];
export const SUPPORTED_MODES = ['autonomous', 'manual', 'test'];

export const CFG_DEFAULT = {
  enabled: false,
  mode: '',           // one of SUPPORTED_MODES; blank = not chosen
  channels: [],       // subset of SUPPORTED_CHANNELS; empty = not chosen
  perRunCap: 0,
  dailyCap: 0,
  lifetimeCap: 0,
  perRunSpendCap: 0,
  dailySpendCap: 0,
  // Owner-set BUDGET RESERVE per postcard, in cents. This is what the atomic
  // spend caps count against — a reservation, not a claim about Lob's actual
  // charge. There is no default and no live price table anywhere in this repo:
  // arming is impossible until the owner types a number.
  postcardReserveCents: 0,
};

const clean = (v, n = 200) => String(v == null ? '' : v).trim().slice(0, n);

export async function getOutreachConfig() {
  const v = await cmd(['GET', CFG_KEY]);
  if (!v) return { ...CFG_DEFAULT };
  try { return { ...CFG_DEFAULT, ...JSON.parse(v) }; } catch { return { ...CFG_DEFAULT }; }
}

export async function saveOutreachConfig(cfg) {
  await cmd(['SET', CFG_KEY, JSON.stringify(cfg)]);
  return cfg;
}

function validPosInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n === Math.floor(n) && n > 0;
}

export function outreachConfigArmable(cfg) {
  const c = cfg || {};
  return !!c.enabled
    && validPosInt(c.perRunCap)
    && validPosInt(c.dailyCap)
    && validPosInt(c.lifetimeCap)
    && validPosInt(c.perRunSpendCap)
    && validPosInt(c.dailySpendCap)
    && validPosInt(c.postcardReserveCents)
    && Array.isArray(c.channels)
    && c.channels.length > 0
    && c.channels.every((ch) => SUPPORTED_CHANNELS.includes(ch))
    && SUPPORTED_MODES.includes(c.mode);
}

// A cap field may be absent (left blank) or a non-negative integer. Fractional,
// negative, NaN and non-numeric values are rejected outright — never floored or
// defaulted into something Chris did not choose.
function validStoredCap(v) {
  const n = Number(v);
  return Number.isFinite(n) && n === Math.floor(n) && n >= 0;
}

export function validateOutreachConfigPatch(cur, body) {
  const next = { ...cur };
  if (body.enabled !== undefined) next.enabled = !!body.enabled;
  if (body.mode !== undefined) next.mode = clean(body.mode, 40);
  if (body.channels !== undefined) {
    next.channels = Array.isArray(body.channels)
      ? body.channels.map((c) => clean(c, 40)).filter(Boolean)
      : [];
  }
  for (const f of ['perRunCap', 'dailyCap', 'lifetimeCap', 'perRunSpendCap', 'dailySpendCap', 'postcardReserveCents']) {
    if (body[f] === undefined) continue;
    if (!validStoredCap(body[f])) {
      return { error: 'invalid_config', message: `${f} must be a non-negative integer.` };
    }
    next[f] = Number(body[f]);
  }

  if (next.enabled && !outreachConfigArmable(next)) {
    return { error: 'incomplete_config', message: 'Enabling outreach requires positive integer caps, a per-card budget reserve (postcardReserveCents), a supported mode, and at least one supported channel.' };
  }
  return { config: next };
}

/**
 * ONE runId per top-level runOutreach invocation. Uniqueness comes from the
 * random suffix — never from the calendar — so two invocations on the same
 * day get independent per-run cap namespaces while the daily counters (keyed
 * by UTC date, not runId) stay shared across every run of that day. Tests
 * inject a deterministic runId via the runId option.
 */
function newRunId(channel) {
  return 'outreach-run-' + clean(channel, 40) + '-' + crypto.randomBytes(8).toString('hex');
}

/**
 * Run one bounded, hardened outreach batch for a channel.
 *
 * channelAdapter({ lead, effect, cfg, idempotencyKey, attempt })
 *   -> { ok, providerRef, reason, retryable, spend }
 *
 * selectCandidates(cfg) -> array of lead identities
 *
 * preflightCandidate(lead) -> resolves everything the provider attempt needs
 *   BEFORE any cap is reserved. A throw skips the candidate with zero
 *   reservation — a candidate that cannot be attempted never burns
 *   per-run/daily/lifetime budget.
 *
 * runId -> optional deterministic run identity (tests). Default: a fresh
 *   unique id per invocation, so perRun* counters mean ONE invocation.
 */
export async function runOutreach({
  channel,
  clock = () => new Date(),
  selectCandidates,
  channelAdapter,
  beforeCandidate,
  preflightCandidate,
  runId: runIdOpt,
} = {}) {
  const cfg = await getOutreachConfig();
  if (!outreachConfigArmable(cfg)) {
    return { ran: false, reason: 'not_armed', sent: 0, skipped: 0, dead: 0 };
  }
  if (!cfg.channels.includes(channel)) {
    return { ran: false, reason: 'channel_not_enabled', sent: 0, skipped: 0, dead: 0 };
  }
  // The reservation cost of one send is the owner-configured budget reserve,
  // never a hardcoded provider price. Armable config guarantees a positive
  // integer, so a run can never reach the provider on a guessed cost.
  const costCents = cfg.postcardReserveCents;

  const owner = 'own-' + crypto.randomBytes(8).toString('hex');
  if (!await acquireLease(owner)) {
    return { ran: false, reason: 'lease_held', sent: 0, skipped: 0, dead: 0 };
  }

  const runId = (runIdOpt && clean(runIdOpt, 80)) || newRunId(channel);
  const run = {
    id: runId,
    channel,
    status: 'failed',
    startedAt: clock().toISOString(),
    finishedAt: '',
    considered: 0,
    eligible: 0,
    sent: 0,
    skipped: 0,
    dead: 0,
    unknown: 0,
    capStop: '',
    stopReason: '',
    error: '',
  };

  try {
    const prior = await recordRun({ owner, runId, run: { ...run, status: 'running' } });
    if (!prior) {
      run.stopReason = 'lease_lost';
      run.error = 'could not record run start';
      run.finishedAt = clock().toISOString();
      await recordRun({ owner, runId, run }).catch(() => {});
      return { ran: true, reason: 'failed', run, sent: 0 };
    }

    let candidates = await selectCandidates(cfg);
    if (!Array.isArray(candidates)) {
      run.error = 'selectCandidates must return an array';
      run.finishedAt = clock().toISOString();
      await recordRun({ owner, runId, run }).catch(() => {});
      return { ran: true, reason: 'failed', run, sent: 0 };
    }
    let remainingCap = cfg.perRunCap;

    // Reconcile effects a prior run left non-terminal before spending capacity
    // on new candidates. Each carries its stored lead snapshot so eligibility
    // can be re-derived, and its durable identity (effectId + provider
    // idempotency key) so a retry continues the SAME logical effect instead of
    // reserving a second one.
    const priorByLead = new Map();
    try {
      const pending = await listPendingEffects(channel);
      for (const e of pending) {
        if (e && e.lead && e.lead.id) priorByLead.set(e.lead.id, e);
      }
      const seenIds = new Set();
      const fresh = [];
      for (const l of candidates) {
        if (l && l.id) {
          if (priorByLead.has(l.id)) continue;
          seenIds.add(l.id);
        }
        fresh.push(l);
      }
      const retryLeads = pending.map((e) => e.lead).filter((l) => l && l.id && !seenIds.has(l.id));
      candidates = retryLeads.concat(fresh);
    } catch { /* best-effort: fall through to supplied candidates */ }

    for (const lead of candidates) {
      if (remainingCap <= 0) { run.capStop = 'per_run_cap'; break; }

      if (beforeCandidate) {
        try { await beforeCandidate(lead); } catch { run.skipped++; continue; }
      }

      if (!(await checkLease(owner))) {
        run.stopReason = 'lease_lost';
        break;
      }

      run.considered++;
      const prior = (lead && lead.id && priorByLead.get(lead.id)) || null;

      let eligibility;
      try {
        eligibility = await checkProspectEligibility(lead, { channel });
      } catch {
        run.skipped++;
        continue;
      }
      if (!eligibility.eligible) {
        // A retry candidate that became paid/current/claimed/suppressed/
        // ambiguous between attempts gets no provider call. Its open effect is
        // closed with the exclusion as the terminal reason; the capacity it
        // reserved stays pessimistically accounted.
        if (prior && ![STATUS.ACCEPTED, STATUS.DEAD, STATUS.REJECTED].includes(prior.status)) {
          try {
            const closed = await updateEffect({
              owner, effectId: prior.effectId,
              patch: { status: STATUS.DEAD, terminalReason: 'excluded_' + eligibility.reason, updatedAt: clock().toISOString() },
            });
            if (closed.ok) run.dead++;
          } catch { /* leave the effect for a later reconciliation pass */ }
        }
        run.skipped++;
        continue;
      }
      run.eligible++;

      // Deterministic pre-provider checks run BEFORE the reservation, so a
      // candidate that cannot be attempted right now is skipped without
      // burning per-run/daily/lifetime budget. A preflight throw is treated
      // as transient: no effect is created and the candidate is reconsidered
      // on a later run.
      if (preflightCandidate) {
        try { await preflightCandidate(lead); } catch { run.skipped++; continue; }
      }

      if (!(await renewLease(owner))) {
        run.stopReason = 'lease_lost';
        break;
      }

      const effectBase = {
        runId,
        channel,
        provider: 'lob',
        canonicalId: prior ? prior.canonicalId : eligibility.canonicalId,
        leadId: lead.id || eligibility.canonicalId,
        eligibility,
        lead,
        createdAt: clock().toISOString(),
      };
      const effectId = prior ? prior.effectId : makeEffectId(effectBase);
      const idempotencyKey = prior && prior.idempotencyKey
        ? prior.idempotencyKey
        : makeIdempotencyKey({ effectId, attempt: 0 });

      let reserve;
      try {
        reserve = await reserveEffect({
          owner,
          effect: { ...effectBase, effectId, idempotencyKey },
          cfg,
          costCents,
        });
      } catch (e) {
        run.stopReason = 'reserve_failed';
        run.error = String(e?.message ?? e).slice(0, 300);
        break;
      }

      if (!reserve.ok) {
        if (reserve.status === 'LEASE_LOST') { run.stopReason = 'lease_lost'; break; }
        if (reserve.status === 'LIFETIME_CAP_REACHED') { run.capStop = 'lifetime_cap_reached'; continue; }
        if (reserve.status === 'RUN_CAP_REACHED' || reserve.status === 'DAILY_CAP_REACHED' || reserve.status === 'RUN_SPEND_CAP_REACHED' || reserve.status === 'DAILY_SPEND_CAP_REACHED') {
          run.capStop = reserve.status;
          break;
        }
        run.status = 'failed';
        run.stopReason = reserve.status || 'reserve_failed';
        run.error = 'fatal: ' + run.stopReason;
        run.finishedAt = clock().toISOString();
        await recordRun({ owner, runId, run }).catch(() => {});
        return { ran: true, reason: 'failed', run, sent: run.sent };
      }

      const effect = reserve.effect;
      const isExistingRetryable = reserve.exists && [STATUS.RETRYABLE, STATUS.UNKNOWN, STATUS.RESERVED, STATUS.ATTEMPTING].includes(effect.status);
      if (reserve.exists && !isExistingRetryable) {
        run.skipped++;
        continue;
      }

      const attemptIndex = effect.attempts || 0;
      const attempting = await updateEffect({
        owner, effectId,
        patch: { status: STATUS.ATTEMPTING, attempts: attemptIndex, updatedAt: clock().toISOString() },
      });
      if (!attempting.ok) {
        if (attempting.status === 'LEASE_LOST') { run.stopReason = 'lease_lost'; break; }
        run.skipped++;
        continue;
      }

      let outcome;
      try {
        outcome = await channelAdapter({ lead, effect, cfg, idempotencyKey, attempt: attemptIndex });
      } catch (e) {
        outcome = { ok: false, reason: String(e?.message ?? e).slice(0, 200), retryable: true, spend: 0 };
      }
      if (!outcome || typeof outcome !== 'object') {
        outcome = { ok: false, reason: 'invalid_adapter_outcome', retryable: false, spend: 0 };
      }

      const nextAttempts = attemptIndex + 1;
      let update;
      if (outcome.ok) {
        update = await updateEffect({
          owner, effectId,
          patch: {
            status: STATUS.ACCEPTED,
            providerRef: outcome.providerRef,
            spend: outcome.spend,
            attempts: nextAttempts,
            updatedAt: clock().toISOString(),
          },
        });
      } else if ((outcome.unknown || outcome.retryable) && nextAttempts < MAX_ATTEMPTS) {
        const status = outcome.unknown ? STATUS.UNKNOWN : STATUS.RETRYABLE;
        update = await updateEffect({
          owner, effectId,
          patch: {
            status,
            attempts: nextAttempts,
            lastReason: outcome.reason,
            updatedAt: clock().toISOString(),
          },
        });
        run.unknown++;
      } else {
        update = await updateEffect({
          owner, effectId,
          patch: {
            status: STATUS.DEAD,
            terminalReason: outcome.reason,
            attempts: nextAttempts,
            updatedAt: clock().toISOString(),
          },
        });
        run.dead++;
      }
      if (!update.ok) {
        if (update.status === 'LEASE_LOST') { run.stopReason = 'lease_lost'; break; }
      }
      if (outcome.ok && update.ok) {
        run.sent++;
        remainingCap--;
      }
    }

    run.status = run.stopReason ? 'failed' : 'completed';
    run.finishedAt = clock().toISOString();
    if (run.stopReason === 'lease_lost') {
      run.error = 'lease lost during run';
    }
    await recordRun({ owner, runId, run }).catch(() => {});
    return { ran: true, reason: run.status, run, sent: run.sent };
  } catch (e) {
    run.error = String(e?.message ?? e).slice(0, 300);
    run.finishedAt = clock().toISOString();
    await recordRun({ owner, runId, run }).catch(() => {});
    return { ran: true, reason: 'failed', run, sent: run.sent || 0 };
  } finally {
    await releaseLease(owner).catch(() => {});
  }
}

/**
 * K5 drafted prospects as outreach candidates.
 *
 * A candidate qualifies once K5 has produced its draft (draftStatus 'drafted'
 * with a durable draftSlug). The outreach lead keeps the draftSlug on the
 * snapshot so the effect ledger records which draft this contact belongs to,
 * but it deliberately carries NO siteSlug: the provider prints the existing
 * plain-offer card and the draft is left untouched. Prospects without a mailable address are
 * not candidates; eligibility is still re-derived per attempt inside the run.
 */
export async function draftedProspectCandidates() {
  const cands = await getCandidates();
  return Object.values(cands)
    .filter((c) => c && c.placeId && c.draftStatus === 'drafted' && c.draftSlug)
    .map((c) => {
      const lead = { ...candidateToLead(c), placeId: c.placeId, draftSlug: c.draftSlug };
      return hasAddr(lead) ? lead : null;
    })
    .filter(Boolean);
}

/**
 * The ACTUAL K6 postcard send pool, assembled once and shared by the run path
 * and the readiness report so both always agree on what would be considered.
 *
 * The pool is the legacy lead queue (ks:leads, in-queue = addressed, unmailed,
 * not bad-address, not suppressed) PLUS K5 drafted prospects (deduped by lead
 * id AND by strong legacy identity — phone / exact name+city / address
 * fingerprint — because a drafted candidate's id is its Place ID, which a
 * legacy lead never carries; id alone cannot keep the same business out of
 * the pool twice). idFilter scopes a manual owner send; it is applied BEFORE
 * the dedupe so a filtered id can never free a slot for a duplicate identity.
 *
 * Returns { legacyQueued, drafted, pool } — pool = legacyQueued ++ drafted.
 */
export async function postcardCandidatePool({ idFilter = null } = {}) {
  const leads = await getLeads();
  const meta = await getLeadMeta();
  const legacyQueued = leads
    .filter((l) => l && l.id)
    .filter((l) => !idFilter || idFilter.has(l.id))
    .map((l) => ({ ...l, ...(meta[l.id] || {}) }))
    .filter((l) => inQueue(l));
  const seen = new Set(legacyQueued.map((l) => l.id));
  const drafted = (await draftedProspectCandidates())
    .filter((l) => !seen.has(l.id))
    .filter((l) => !matchLegacyLead(l, legacyQueued))
    .filter((l) => !idFilter || idFilter.has(l.id));
  return { legacyQueued, drafted, pool: legacyQueued.concat(drafted) };
}

/**
 * Postcard preflight: resolve the lead's destination BEFORE the effect
 * reservation, so a store failure skips the candidate without consuming
 * per-run/daily/lifetime budget. Owner destination policy: a published
 * siteSlug yields the delivery card naming that live URL; an unpublished or
 * missing site falls back to the plain-offer /start card. Nothing is ever
 * published here. The resolved string ('' = plain offer) rides the lead into
 * the adapter as resolvedSiteUrl, so the provider attempt does no second
 * lookup.
 */
async function resolvePostcardDestination(lead) {
  let siteUrl = '';
  if (lead && lead.siteSlug) {
    const site = await getSite(lead.siteSlug);
    if (site && site.published) siteUrl = 'killswitchwebsites.com/s/' + site.slug;
  }
  lead.resolvedSiteUrl = siteUrl;
}

/**
 * The wired-up postcard run shared by cron-mail and the owner admin actions,
 * so every entry point gets identical eligibility, effect reservation, cap,
 * and provider-idempotency behavior. When the K6 config is not armed this
 * returns { ran: false, reason: 'not_armed' } and no provider is called.
 *
 * idFilter (a Set of lead ids) scopes a manual owner send; requestCeiling is a
 * hard bound on how many candidates one request may consider, on top of — never
 * instead of — the configured caps.
 */
export async function runPostcardOutreach({ clock = () => new Date(), idFilter = null, requestCeiling = 250, runId = null } = {}) {
  const ceiling = Math.max(1, Math.min(250, Math.floor(Number(requestCeiling)) || 250));
  return runOutreach({
    channel: 'postcard',
    clock,
    runId,
    selectCandidates: async () => (await postcardCandidatePool({ idFilter })).pool.slice(0, ceiling),
    channelAdapter: sendPostcard,
    preflightCandidate: resolvePostcardDestination,
  });
}

/**
 * CANARY READINESS — aggregate-only operator view, owner-authenticated callers
 * only (api/admin.js enforces that). Counts and reason/trade/city aggregates
 * exclusively: no prospect names, emails, phones, street addresses, KV keys,
 * or provider secrets.
 *
 * THE SEND POOL IS THE RUN'S POOL. Eligibility is reported over the exact
 * candidate assembly runPostcardOutreach consumes (postcardCandidatePool):
 * the legacy lead queue PLUS K5 drafted prospects, deduped by lead id. The
 * earlier version rechecked only drafted prospects, so readiness said
 * "0 eligible" while the run would have considered the whole legacy queue.
 *
 * Eligibility uses the SAME authoritative check the run loop uses
 * (lib/outreach-eligibility.js), against state cached at read time — this is a
 * report, not a send, so per-candidate freshness is not required and nothing
 * here reserves or mutates anything.
 */
export async function outreachReadiness() {
  const cfg = await getOutreachConfig();
  const cands = Object.values(await getCandidates()).filter(Boolean);
  const ranked = cands.filter((c) => c.status === 'ranked');
  const drafted = cands.filter((c) => c.draftStatus === 'drafted' && c.draftSlug);
  const draftedMailable = drafted.filter((c) => hasAddr(candidateToLead(c)));

  const { legacyQueued, pool } = await postcardCandidatePool({});

  const [suppressionState, accountList, siteList, emailMap] = await Promise.all([
    getSuppressionState(),
    getAccounts(),
    listSites(),
    siteSlugsByEmail(),
  ]);
  const caches = { suppressionState, accountList, siteList, siteEmailMap: emailMap };

  let eligible = 0;
  const ineligibleReasons = {};
  const byTrade = {};
  const byCity = {};
  for (const lead of pool) {
    let r;
    try { r = await checkProspectEligibility(lead, { channel: 'postcard', ...caches }); }
    catch { r = { eligible: false, reason: 'check_error' }; }
    if (r.eligible) {
      eligible++;
      const trade = clean(lead.trade || 'unknown', 60) || 'unknown';
      const city = clean([lead.city, lead.state].filter(Boolean).join(', '), 80) || 'unknown';
      byTrade[trade] = (byTrade[trade] || 0) + 1;
      byCity[city] = (byCity[city] || 0) + 1;
    } else {
      ineligibleReasons[r.reason] = (ineligibleReasons[r.reason] || 0) + 1;
    }
  }

  return {
    armed: outreachConfigArmable(cfg),
    providerMode: lobKeyMode(),
    sender: senderConfigPresence(),
    postcardReserve: {
      configured: validPosInt(cfg.postcardReserveCents),
      cents: validPosInt(cfg.postcardReserveCents) ? cfg.postcardReserveCents : null,
    },
    // K4/K5 pipeline inventory.
    candidates: {
      total: cands.length,
      ranked: ranked.length,
      drafted: drafted.length,
      draftedMailable: draftedMailable.length,
    },
    // The send pool the run actually consumes, both sources and the deduped
    // union. Every pool member is address-complete by construction, so
    // mailable === pool.
    legacyQueue: legacyQueued.length,
    pool: pool.length,
    mailable: pool.length,
    eligible,
    ineligibleReasons,
    eligibleByTrade: byTrade,
    eligibleByCity: byCity,
    effectsByStatus: await getStatusCounts(),
  };
}
