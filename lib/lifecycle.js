// Durable customer lifecycle and event ledger.
//
// Email is the stable customer identity already used by accounts, sites and
// billing. Current state is one hash field per customer; immutable events are
// one hash per customer, keyed by a deterministic id when a caller supplies an
// idempotency key. Replaying a webhook or signup repairs state without creating
// a second business event.

import crypto from 'node:crypto';
import { cmd, pipeline, parseHash } from './kv.js';

const STATE_KEY = 'ks:lifecycle:state';

export const LIFECYCLE_STAGES = [
  'lead_received',
  'site_published',
  'onboarded',
  'integrations_required',
  'integrations_ready',
  'active',
  'service_completed',
  'review_requested',
];

const RANK = Object.fromEntries(LIFECYCLE_STAGES.map((stage, index) => [stage, index]));

function customerId(email) {
  return String(email || '').trim().toLowerCase();
}

function eventsKey(email) {
  return 'ks:lifecycle:events:' + encodeURIComponent(customerId(email));
}

function safeData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  try {
    const json = JSON.stringify(value);
    if (json.length > 4000) return { truncated: true };
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function parse(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function eventId(email, key) {
  if (!key) return crypto.randomUUID();
  return crypto.createHash('sha256').update(customerId(email) + '|' + String(key)).digest('hex').slice(0, 32);
}

export async function getLifecycleState(email) {
  const id = customerId(email);
  if (!id) return null;
  return parse(await cmd(['HGET', STATE_KEY, id]));
}

export async function getLifecycleStates() {
  const raw = parseHash(await cmd(['HGETALL', STATE_KEY]));
  const out = {};
  for (const [email, value] of Object.entries(raw)) {
    const parsed = parse(value);
    if (parsed) out[email] = parsed;
  }
  return out;
}

export async function getLifecycleEvents(email, limit = 100) {
  const id = customerId(email);
  if (!id) return [];
  const raw = parseHash(await cmd(['HGETALL', eventsKey(id)]));
  return Object.values(raw).map(parse).filter(Boolean)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, Math.min(Math.max(1, Number(limit) || 100), 500));
}

/**
 * Append an event and project it into the customer's current state.
 * A lower-ranked late event stays in history but cannot move state backwards.
 */
export async function recordLifecycle(email, {
  type,
  stage,
  idempotencyKey,
  data,
  blocked,
  blocker,
} = {}) {
  const id = customerId(email);
  if (!id || !id.includes('@')) throw new Error('valid lifecycle email required');
  if (!type || typeof type !== 'string') throw new Error('lifecycle event type required');
  if (stage && !(stage in RANK)) throw new Error('unknown lifecycle stage: ' + stage);

  const eid = eventId(id, idempotencyKey);
  const ekey = eventsKey(id);
  const existing = parse(await cmd(['HGET', ekey, eid]));
  const currentRecord = await getLifecycleState(id);
  if (existing && currentRecord) {
    return { event: existing, state: currentRecord, duplicate: true };
  }
  const current = currentRecord || {
    email: id,
    stage: null,
    status: 'active',
    blocker: '',
    enteredAt: '',
    updatedAt: '',
  };

  const at = existing?.at || new Date().toISOString();
  const advances = stage && (current.stage == null || RANK[stage] >= RANK[current.stage]);
  const next = { ...current, email: id };
  if (advances) {
    if (stage !== current.stage) next.enteredAt = at;
    next.stage = stage;
  }
  if (blocked === true) {
    next.status = 'blocked';
    next.blocker = String(blocker || 'unspecified').slice(0, 240);
    next.requiredStage = stage || next.stage || '';
  } else if (blocked === false) {
    next.status = 'active';
    next.blocker = '';
    next.requiredStage = '';
  }
  next.updatedAt = at;
  next.lastEventType = String(type).slice(0, 120);
  next.lastEventId = eid;

  const event = existing || {
    id: eid,
    email: id,
    type: String(type).slice(0, 120),
    stage: stage || current.stage || null,
    stateApplied: !!advances,
    blocked: blocked === true,
    blocker: blocked === true ? next.blocker : '',
    data: safeData(data),
    at,
  };

  // Same field + same payload makes retries safe. If the first pipeline only
  // wrote the event, the retry still repairs the state projection.
  await pipeline([
    ['HSET', ekey, eid, JSON.stringify(event)],
    ['HSET', STATE_KEY, id, JSON.stringify(next)],
  ]);
  return { event, state: next, duplicate: !!existing };
}

export function requiredIntegrations(phases = [], site = {}) {
  const enabled = new Set(Array.isArray(phases) ? phases : []);
  const missing = [];
  if (enabled.has('P1') && !site.googleBusinessProfile) missing.push('google_business_profile');
  if (enabled.has('P3') && !site.bookingUrl) missing.push('calendar_booking_url');
  if (enabled.has('P7') && !site.payUrl) missing.push('stripe_connect_or_payment_url');
  return missing;
}

/** Project a newly onboarded or newly paid customer into the truthful stage. */
export async function reconcileLifecycle({ email, account = {}, site = {}, phases, idempotencyKey = 'reconcile' }) {
  const enabled = Array.isArray(phases)
    ? phases
    : [...new Set([...(account.plan || []), ...(account.owned || []), ...(site.modules || [])])];

  if (!site || !site.published) {
    return recordLifecycle(email, {
      type: 'lifecycle.blocked',
      stage: 'onboarded',
      blocked: true,
      blocker: 'site_not_published',
      data: { phases: enabled },
      idempotencyKey: idempotencyKey + ':site-not-published',
    });
  }

  const missing = requiredIntegrations(enabled, site);
  if (missing.length) {
    return recordLifecycle(email, {
      type: 'integrations.required',
      stage: 'integrations_required',
      blocked: true,
      blocker: missing.join(','),
      data: { missing, phases: enabled, siteSlug: site.slug || '' },
      idempotencyKey: idempotencyKey + ':integrations-required:' + missing.join(','),
    });
  }

  return recordLifecycle(email, {
    type: 'customer.activated',
    stage: 'active',
    blocked: false,
    data: { phases: enabled, siteSlug: site.slug || '' },
    idempotencyKey: idempotencyKey + ':active',
  });
}

/** Seed truthful current state for accounts that predate the ledger. */
export async function backfillLifecycle({ accounts = {}, sites = [], limit = 25 } = {}) {
  const states = await getLifecycleStates();
  const byEmail = {};
  for (const site of sites || []) {
    const email = customerId(site && site.email);
    if (email && !byEmail[email]) byEmail[email] = site;
  }
  const pending = Object.values(accounts || {}).filter((account) => {
    const email = customerId(account && account.email);
    return email && !states[email];
  });
  const batch = pending.slice(0, Math.min(Math.max(1, Number(limit) || 25), 100));
  const results = [];
  for (let i = 0; i < batch.length; i += 5) {
    const part = batch.slice(i, i + 5);
    results.push(...await Promise.all(part.map((account) => reconcileLifecycle({
      email: account.email,
      account,
      site: byEmail[customerId(account.email)] || {},
      idempotencyKey: 'backfill:v1',
    }))));
  }
  return { seeded: results.length, remaining: Math.max(0, pending.length - batch.length) };
}
