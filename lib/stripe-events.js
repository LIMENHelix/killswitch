// Stripe event delivery is at-least-once. A short processing lock prevents two
// workers from fulfilling the same event concurrently; the longer done marker
// makes later retries a no-op. A failed handler releases the lock and returns a
// non-2xx response so Stripe retries instead of permanently losing fulfillment.
import { cmd } from './kv.js';

const doneKey = (id) => 'ks:stripe:done:' + id;
const lockKey = (id) => 'ks:stripe:lock:' + id;

export async function beginStripeEvent(id) {
  const eventId = String(id || '').trim();
  if (!eventId) return { state: 'invalid' };
  if (await cmd(['GET', doneKey(eventId)])) return { state: 'done' };
  const lock = await cmd(['SET', lockKey(eventId), new Date().toISOString(), 'NX', 'EX', '300']);
  return { state: lock === 'OK' ? 'claimed' : 'busy' };
}

export async function completeStripeEvent(id) {
  const eventId = String(id || '').trim();
  await cmd(['SET', doneKey(eventId), new Date().toISOString(), 'EX', String(180 * 86400)]);
  await cmd(['DEL', lockKey(eventId)]);
}

export async function releaseStripeEvent(id) {
  const eventId = String(id || '').trim();
  if (eventId) await cmd(['DEL', lockKey(eventId)]);
}
