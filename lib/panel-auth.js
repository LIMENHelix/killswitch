// Passwordless portal auth. A customer's portal link is
//   /panel?e=<email>&t=<token>
// where token is a short HMAC of their (lowercased) email with a server secret.
// Only this server knows KS_PANEL_SECRET, so the link can't be forged, and there
// is no password to manage. Fails closed: no secret set => no valid token.
import crypto from 'crypto';

function secret() { return process.env.KS_PANEL_SECRET || ''; }

export function panelToken(email) {
  const s = secret();
  if (!s) return '';
  const e = String(email || '').trim().toLowerCase();
  return crypto.createHmac('sha256', s).update(e).digest('hex').slice(0, 40);
}

export function verifyPanel(email, token) {
  const expected = panelToken(email);
  if (!expected || !token) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
