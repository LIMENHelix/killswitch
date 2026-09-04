// One durable do-not-contact decision shared by every outbound channel.
//
// A suppression is indexed by every stable identifier we know (lead id, email,
// phone and postal address). The values stored as hash fields are SHA-256
// fingerprints, not raw contact details. This lets a STOP received by email
// also block a call or postcard for the same person without exposing addresses
// in Redis key names.

import crypto from 'node:crypto';
import { cmd, pipeline, parseHash } from './kv.js';

const KEY = 'ks:suppressions';
const clean = (v, n = 320) => String(v == null ? '' : v).trim().slice(0, n);
const compact = (v) => clean(v).toLowerCase().replace(/[^a-z0-9]/g, '');
const digest = (v) => crypto.createHash('sha256').update(v).digest('hex');

function rawIdentifiers(contact = {}) {
  const out = [];
  const id = clean(contact.id, 160).toLowerCase();
  const email = clean(contact.email, 320).toLowerCase();
  const phone = clean(contact.phone, 80).replace(/\D/g, '');
  const address = [contact.street, contact.city, contact.state, contact.zip].map(compact).filter(Boolean).join('|');
  if (id) out.push('id:' + id);
  if (email && email.includes('@')) out.push('email:' + email);
  if (phone.length >= 7) out.push('phone:' + phone.slice(-10));
  if (address && clean(contact.street) && clean(contact.zip)) out.push('address:' + address);
  return [...new Set(out)];
}

export function fingerprints(contact = {}) {
  return rawIdentifiers(contact).map((v) => digest(v));
}

function snapshot(contact = {}) {
  return {
    id: clean(contact.id, 160),
    name: clean(contact.name, 160),
    email: clean(contact.email, 320).toLowerCase(),
    phone: clean(contact.phone, 80),
    address: [contact.street, contact.city, contact.state, contact.zip].map((v) => clean(v, 160)).filter(Boolean).join(', '),
  };
}

function recordField(id) { return 'r:' + clean(id, 100); }
function indexField(fp) { return 'i:' + fp; }

/** Read the single hash once for list screens and outbound batches. */
export async function getSuppressionState() {
  return parseHash(await cmd(['HGETALL', KEY]));
}

/** Pure lookup against an already-loaded state map. */
export function matchSuppression(contact, state = {}) {
  for (const fp of fingerprints(contact)) {
    const id = state[indexField(fp)];
    const rec = id && state[recordField(id)];
    if (rec && rec.active !== false) return rec;
  }
  return null;
}

export async function getSuppression(contact) {
  return matchSuppression(contact, await getSuppressionState());
}

/**
 * Suppress every known route to this contact. Repeating the action enriches the
 * same record instead of creating another decision or losing earlier indexes.
 */
export async function suppressContact(contact, { reason, actor, source } = {}) {
  const fps = fingerprints(contact);
  if (!fps.length) throw new Error('contact identifier required');
  const state = await getSuppressionState();
  const existing = matchSuppression(contact, state);
  const id = existing?.id || ('sup_' + fps[0].slice(0, 32));
  const now = new Date().toISOString();
  const incoming = snapshot(contact);
  const mergedContact = { ...(existing?.contact || {}) };
  for (const [field, value] of Object.entries(incoming)) if (value) mergedContact[field] = value;
  const rec = {
    ...(existing || {}),
    id,
    active: true,
    contact: mergedContact,
    fingerprints: [...new Set([...(existing?.fingerprints || []), ...fps])],
    reason: clean(reason, 500) || existing?.reason || 'Do not contact',
    source: clean(source, 80) || existing?.source || 'manual',
    suppressedBy: clean(actor, 120) || existing?.suppressedBy || 'operator',
    suppressedAt: existing?.suppressedAt || now,
    updatedAt: now,
    liftedAt: '',
    liftedBy: '',
  };
  await pipeline([
    ['HSET', KEY, recordField(id), JSON.stringify(rec)],
    ...rec.fingerprints.map((fp) => ['HSET', KEY, indexField(fp), id]),
  ]);
  return rec;
}

/** Lift a suppression without erasing its audit history. */
export async function liftSuppression(id, actor = 'operator') {
  const key = clean(id, 100);
  if (!/^sup_[a-f0-9]{32}$/.test(key)) return null;
  const raw = await cmd(['HGET', KEY, recordField(key)]);
  let rec;
  try { rec = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { rec = null; }
  if (!rec) return null;
  if (rec.active === false) return { record: rec, duplicate: true };
  const now = new Date().toISOString();
  const lifted = { ...rec, active: false, liftedAt: now, liftedBy: clean(actor, 120), updatedAt: now };
  await pipeline([
    ...((rec.fingerprints || []).map((fp) => ['HDEL', KEY, indexField(fp)])),
    ['HSET', KEY, recordField(key), JSON.stringify(lifted)],
  ]);
  return { record: lifted, duplicate: false };
}

export async function listSuppressions({ activeOnly = true } = {}) {
  const state = await getSuppressionState();
  return Object.entries(state)
    .filter(([field, rec]) => field.startsWith('r:') && rec && (!activeOnly || rec.active !== false))
    .map(([, rec]) => rec)
    .sort((a, b) => String(b.suppressedAt).localeCompare(String(a.suppressedAt)));
}
