// Shared cron endpoint authentication.
//
// Cron URLs are bearer-only: `Authorization: Bearer <CRON_SECRET>`. No query
// token, no body token, no x-vercel-cron trust — a cron URL that spends money
// or sends email must never be reachable without the project secret. The
// comparison is constant-time with a length pre-check, the same pattern
// lib/panel-auth.js uses for customer panel tokens.
import crypto from 'node:crypto';

export function cronAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const bearer = (req && req.headers && req.headers.authorization) || '';
  const expected = 'Bearer ' + secret;
  const x = Buffer.from(String(bearer));
  const y = Buffer.from(expected);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
