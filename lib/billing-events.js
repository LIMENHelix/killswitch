// Durable money-event ledger for the operator scorecard and incident trail.
//
// Stripe retries webhooks and may deliver them concurrently. The webhook claim
// prevents duplicate handling, while this hash uses a stable provider event or
// object key as the field so equivalent Stripe notifications collapse into one
// business event.
import { cmd, parseHash } from './kv.js';

const KEY = 'ks:billing:events';
const clean = (value, max = 320) => String(value == null ? '' : value).trim().slice(0, max);

export async function recordBillingEvent({ id, type, email, customerId, amountCents, currency, status, reason, sourceId, at, dedupeKey } = {}) {
  const eventId = clean(id, 180);
  const eventType = clean(type, 120);
  if (!eventId || !eventType) throw new Error('billing event id and type required');
  const amount = Number(amountCents);
  const record = {
    id: eventId,
    type: eventType,
    email: clean(email).toLowerCase(),
    customerId: clean(customerId, 180),
    amountCents: Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : 0,
    currency: clean(currency, 12).toLowerCase(),
    status: clean(status, 80),
    reason: clean(reason, 240),
    sourceId: clean(sourceId, 180),
    at: clean(at, 40) || new Date().toISOString(),
  };
  const field = clean(dedupeKey, 220) || eventId;
  const raw = await cmd(['HGET', KEY, field]);
  let existing = null;
  try { existing = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { existing = null; }
  const signature = (value) => JSON.stringify([
    value && value.type, value && value.email, value && value.amountCents,
    value && value.currency, value && value.status, value && value.reason, value && value.sourceId,
  ]);
  if (existing && signature(existing) === signature(record)) return { ...existing, duplicate: true };
  if (!existing) {
    const created = await cmd(['HSETNX', KEY, field, JSON.stringify(record)]);
    if (Number(created) === 1) return { ...record, duplicate: false };
    const racedRaw = await cmd(['HGET', KEY, field]);
    let raced = null;
    try { raced = typeof racedRaw === 'string' ? JSON.parse(racedRaw) : racedRaw; } catch { raced = null; }
    if (raced && signature(raced) === signature(record)) return { ...raced, duplicate: true };
  }
  await cmd(['HSET', KEY, field, JSON.stringify(record)]);
  return { ...record, duplicate: false };
}

export async function listBillingEvents({ since = '', until = '', limit = 500 } = {}) {
  const raw = parseHash(await cmd(['HGETALL', KEY]));
  return Object.values(raw).filter((record) => record && record.id)
    .filter((record) => !since || String(record.at) >= String(since))
    .filter((record) => !until || String(record.at) < String(until))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, Math.min(Math.max(1, Number(limit) || 500), 2500));
}
