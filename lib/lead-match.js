// Strong exact identity match against the legacy outreach queue (ks:leads).
//
// WHY: legacy leads carry no Google Place ID — the manual finder discarded it
// (their ids are md5(trade|name|zip)[:12], see _outreach/seed_kv.py). A K4
// candidate's canonical identity IS the Place ID, so the two pools can never
// reconcile by id alone: without this check, discovery would happily rank a
// business that already sits in the ~2,575-strong legacy queue, K5 would
// draft it, and the K6 pool would hold the SAME business twice under two
// identities — two postcards to one address, because the lifetime cap keys on
// canonical identity and the identities differ.
//
// The signals are the same strong exact ones suppression matching and K5
// reconciliation already use: normalized 10-digit phone, exact normalized
// name+city, and the compacted street|city|state|zip fingerprint (address
// signal only when the candidate actually has street AND zip — a partial
// address can never be a match). Similar names are NOT matches. Multiple
// distinct hits = ambiguous identity: still a match (fail closed), never a
// guess.

const clean = (v, n = 200) => String(v == null ? '' : v).trim().slice(0, n);
const norm = (v) => clean(v).toLowerCase().replace(/[^a-z0-9]/g, '');
const normPhone = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 7 ? d.slice(-10) : ''; };
const compactAddress = ({ street, city, state, zip }) =>
  [street, city, state, zip].map((p) => clean(p)).filter(Boolean).join('|').toLowerCase().replace(/[^a-z0-9|]/g, '');

/**
 * @returns {null | { signal: string, ambiguous: boolean, lead: object|null }}
 *   null when no legacy lead matches; otherwise the first match with the
 *   signal that produced it ('phone' | 'name+city' | 'address' | 'multiple').
 */
export function matchLegacyLead(identity, leads) {
  const id = identity || {};
  const phone = normPhone(id.phone);
  const cn = norm(id.name), cc = norm(id.city);
  // The address signal requires a full street+zip on the CANDIDATE side;
  // otherwise a bare city|state fragment would over-match.
  const addr = clean(id.street) && clean(id.zip) ? compactAddress(id) : '';

  const hits = [];
  for (const l of Array.isArray(leads) ? leads : []) {
    if (!l) continue;
    if (phone && normPhone(l.phone) === phone) { hits.push({ lead: l, signal: 'phone' }); continue; }
    if (cn && cc && norm(l.name) === cn && norm(l.city) === cc) { hits.push({ lead: l, signal: 'name+city' }); continue; }
    if (addr && compactAddress(l) === addr) { hits.push({ lead: l, signal: 'address' }); }
  }
  if (!hits.length) return null;
  const distinct = new Set(hits.map((h) => String(h.lead.id || '')));
  if (distinct.size > 1) return { signal: 'multiple', ambiguous: true, lead: null };
  return { signal: hits[0].signal, ambiguous: false, lead: hits[0].lead };
}
