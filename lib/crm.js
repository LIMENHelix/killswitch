// P5 CRM: the customer's own contact list.
//
// The data was ALREADY THERE and we were throwing it away. Every contact-form
// message and every booking request on a customer's site got emailed and then
// existed nowhere. So the shop owner's "customer list" was their inbox, which is
// exactly the problem the module is sold to solve.
//
// This keeps them. One record per person, not one per message: someone who
// enquires in March and books in June is ONE contact with two entries, which is
// what "full contact history" and "nobody gets forgotten" actually mean.
//
// Storage: ks:crm:<slug> is a HASH, field = contact id, value = the record.
// A hash because contacts are written one at a time and read all at once, and
// because two enquiries landing together must not clobber each other the way a
// read-modify-write of one JSON blob would.
import { cmd, parseHash } from './kv.js';

const key = (slug) => 'ks:crm:' + String(slug || '').trim();

// What the customer can set on a contact. Deliberately short: a shop owner is
// not going to maintain a nine-stage pipeline, and a stage nobody updates is
// worse than no stage at all.
export const STATUSES = ['new', 'contacted', 'won', 'lost'];

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

/** Stable id from whatever they gave us, so the same person merges. */
export function contactId(handle) {
  const h = String(handle || '').toLowerCase().replace(/[^a-z0-9@.]/g, '');
  return h.slice(0, 60) || 'unknown';
}

function blank(id) {
  return {
    id, name: '', handle: '', email: '', phone: '',
    status: 'new', note: '',
    createdAt: '', updatedAt: '', entries: [],
  };
}

/**
 * Record an enquiry against a site's contact list.
 * Fire and forget at the call site: losing a CRM write must never stop the
 * message reaching the business by email.
 *
 * @param {string} slug
 * @param {object} o
 * @param {string} o.name     who they are
 * @param {string} o.handle   whatever they left, phone or email
 * @param {string} o.kind     'message' | 'booking'
 * @param {string} o.text     the message, or the time they asked for
 * @param {string} [o.at]     ISO timestamp; caller supplies so this stays testable
 */
export async function recordContact(slug, { name, handle, kind, text, at }) {
  const s = String(slug || '').trim();
  if (!s) return null;
  const id = contactId(handle || name);
  const when = at || new Date().toISOString();

  const raw = await cmd(['HGET', key(s), id]);
  let rec = blank(id);
  if (raw) { try { rec = { ...rec, ...JSON.parse(raw) }; } catch { /* keep blank */ } }

  const h = clip(handle, 120);
  rec.name = clip(name, 80) || rec.name;
  rec.handle = h || rec.handle;
  // Split it so the panel can offer tap-to-call and mailto without guessing,
  // and so P6 knows whether it has anywhere to send a follow-up.
  if (h.includes('@')) rec.email = h;
  else if (/\d/.test(h)) rec.phone = h;
  if (!rec.createdAt) rec.createdAt = when;
  rec.updatedAt = when;
  rec.entries = [...(rec.entries || []), { at: when, kind: kind || 'message', text: clip(text, 1200) }].slice(-40);

  await cmd(['HSET', key(s), id, JSON.stringify(rec)]);
  return rec;
}

/** Everyone who has ever contacted this site, newest first. */
export async function listContacts(slug) {
  const s = String(slug || '').trim();
  if (!s) return [];
  const all = parseHash(await cmd(['HGETALL', key(s)]));
  return Object.values(all)
    .filter((r) => r && r.id)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

/** The customer marking someone contacted, won or lost, or leaving a note. */
export async function updateContact(slug, id, patch) {
  const s = String(slug || '').trim();
  if (!s || !id) return null;
  const raw = await cmd(['HGET', key(s), id]);
  if (!raw) return null;
  let rec;
  try { rec = JSON.parse(raw); } catch { return null; }

  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status)) return null;
    rec.status = patch.status;
  }
  if (patch.note !== undefined) rec.note = clip(patch.note, 800);
  rec.updatedAt = patch.at || new Date().toISOString();

  await cmd(['HSET', key(s), id, JSON.stringify(rec)]);
  return rec;
}

/** Headline counts for the panel, so the shop owner sees the shape at a glance. */
export function summarise(contacts) {
  const out = { total: contacts.length, new: 0, contacted: 0, won: 0, lost: 0 };
  for (const c of contacts) if (out[c.status] !== undefined) out[c.status]++;
  return out;
}
