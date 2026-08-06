// Who is holding this key, and what it is allowed to do.
//
// There used to be exactly one credential. ADMIN_KEY (falling back to
// SWITCH_TOKEN) opened the lead board, the customer list, every customer's
// private portal link, real Lob postage and the mailing autopilot. A commissioned
// rep needs the lead board. Handing them that key handed them all of it, with no
// record of who did what and no way to revoke one person.
//
// REP_KEYS is a comma separated list of name:key pairs:
//   REP_KEYS="dana:r_8fj2xq...,mike:r_2kd9pl..."
// One key each, so revoking a rep who leaves does not log anyone else out, and
// every stage change and note is stamped with the name that made it.
//
// A rep may READ the board and record what happened on a call. A rep may not
// spend postage, arm the autopilot, reseed the list, open the customer or
// revenue screens, or mint a customer account. Those stay with the owner key.

export const OWNER = 'owner';
export const REP = 'rep';

function parseReps() {
  const out = [];
  for (const pair of String(process.env.REP_KEYS || '').split(',')) {
    const i = pair.indexOf(':');
    if (i < 1) continue;
    const name = pair.slice(0, i).trim();
    const key = pair.slice(i + 1).trim();
    if (name && key) out.push({ name, key });
  }
  return out;
}

/**
 * Resolve a presented token to who is holding it.
 * @returns {{role:string, name:string}|null} null means not recognised
 */
export function identify(token) {
  const t = String(token || '');
  if (!t) return null;
  const owner = [process.env.ADMIN_KEY, process.env.SWITCH_TOKEN].filter(Boolean);
  if (owner.includes(t)) return { role: OWNER, name: 'operator' };
  const rep = parseReps().find((r) => r.key === t);
  if (rep) return { role: REP, name: rep.name };
  return null;
}

export function isOwner(who) { return !!who && who.role === OWNER; }

/** True when at least one credential exists, so we can 503 rather than 401 blindly. */
export function anyKeyConfigured() {
  return !!(process.env.ADMIN_KEY || process.env.SWITCH_TOKEN || process.env.REP_KEYS);
}
