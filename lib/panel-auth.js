// Passwordless portal auth. A customer's portal link is
//   /panel?e=<email>&t=<token>
//
// The token used to be HMAC(email) alone, which meant a leaked link was
// permanent access and the only way to revoke anyone was rotating
// KS_PANEL_SECRET, which logs out every customer at once.
//
// Now: token = "<expiryBase36>.<hmac40>" where the hmac covers the email, a
// per-account nonce, and the expiry. That buys two things the old one could not:
//   EXPIRY      the link stops working on its own, 90 days by default
//   REVOCATION  change one account's tokenNonce and only that customer's links
//               die. Everyone else is untouched.
//
// The nonce has to live in KV rather than inside the token. If the token carried
// its own nonce, an old token would carry the OLD nonce, verify against itself,
// and revocation would do nothing. So verify reads the account. That is one KV
// read per authenticated panel request, and it is the price of revocation.
//
// Fails closed: no secret set, no valid token.
import crypto from 'crypto';
import { getAccount, upsertAccount } from './store.js';

const DAY = 86400000;
const DEFAULT_TTL_DAYS = 90;

// Tokens minted before this change are 40 hex characters with no separator.
// They keep working until this date so nobody is locked out of a link they were
// already sent, then they stop. A constant rather than an env var, deliberately:
// a grace period that can be silently extended forever is not a grace period.
const LEGACY_ACCEPTED_UNTIL = Date.UTC(2026, 8, 10); // 2026-09-10

function secret() { return process.env.KS_PANEL_SECRET || ''; }

const norm = (email) => String(email || '').trim().toLowerCase();

/**
 * The signing primitive. Synchronous, because callers that already hold the
 * account (api/master.js builds links for every account in one pass) must not
 * have to turn a map into a Promise.all just to sign.
 */
export function signPanel(email, nonce, expMs) {
  const s = secret();
  if (!s) return '';
  const mac = crypto.createHmac('sha256', s)
    .update(`${norm(email)}|${nonce}|${expMs}`)
    .digest('hex').slice(0, 40);
  return `${expMs.toString(36)}.${mac}`;
}

/** The old scheme, kept only to honour tokens already in the wild. */
function legacyToken(email) {
  const s = secret();
  if (!s) return '';
  return crypto.createHmac('sha256', s).update(norm(email)).digest('hex').slice(0, 40);
}

/**
 * The account's current nonce, creating one if this account predates them.
 *
 * upsertAccount is a read-modify-write of the whole account map, so a
 * simultaneous write from another flow can drop a field. If that happens to our
 * freshly written nonce, the token we are about to mint would be dead on
 * arrival. So we re-read afterwards and sign with whatever actually persisted,
 * which makes the mint correct whoever wins the race.
 */
async function nonceFor(email) {
  const e = norm(email);
  const acct = await getAccount(e);
  if (!acct) return null;
  if (acct.tokenNonce) return acct.tokenNonce;

  const fresh = crypto.randomBytes(9).toString('hex');
  await upsertAccount({ email: e, tokenNonce: fresh });
  const after = await getAccount(e);
  return (after && after.tokenNonce) || fresh;
}

/**
 * Mint a portal token. Async because the nonce lives on the account.
 * @returns {Promise<string>} '' when there is no secret or no such account
 */
export async function panelToken(email, { ttlDays = DEFAULT_TTL_DAYS } = {}) {
  if (!secret()) return '';
  let nonce;
  try { nonce = await nonceFor(email); }
  catch (e) { console.error('[panel-auth] nonce read', e); return ''; }
  if (!nonce) return '';
  return signPanel(email, nonce, Date.now() + ttlDays * DAY);
}

/**
 * Check a token. Never throws: a KV outage must return false rather than take
 * the handler down with it.
 * @returns {Promise<boolean>}
 */
export async function verifyPanel(email, token) {
  const s = secret();
  const t = String(token || '');
  if (!s || !t) return false;
  const e = norm(email);

  // ---- legacy: 40 hex, no separator ----
  if (t.indexOf('.') === -1) {
    if (Date.now() >= LEGACY_ACCEPTED_UNTIL) return false;
    const expected = legacyToken(e);
    if (!expected || !same(expected, t)) return false;
    console.warn('[panel-auth] DEPRECATED legacy token accepted for', e,
      '- stops working', new Date(LEGACY_ACCEPTED_UNTIL).toISOString().slice(0, 10));
    return true;
  }

  // ---- current: <expiryBase36>.<hmac40> ----
  const cut = t.indexOf('.');
  const expMs = parseInt(t.slice(0, cut), 36);
  if (!Number.isFinite(expMs) || expMs <= 0) return false;
  if (Date.now() >= expMs) return false;

  // NEVER writes. Verification is a read-only path, so a leaked link cannot be
  // used to create state, and there is no lazy-write race on this side.
  let acct;
  try { acct = await getAccount(e); }
  catch (err) { console.error('[panel-auth] verify store unreachable', err); return false; }
  if (!acct || !acct.tokenNonce) return false;

  return same(signPanel(e, acct.tokenNonce, expMs), t);
}

function same(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Revoke one customer's links by rotating their nonce. Every token already
 * issued to them stops verifying on the next request; nobody else is affected.
 * @returns {Promise<string>} the new nonce
 */
export async function revokePanelTokens(email) {
  const fresh = crypto.randomBytes(9).toString('hex');
  await upsertAccount({ email: norm(email), tokenNonce: fresh });
  return fresh;
}
