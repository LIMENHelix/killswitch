// Onboard a customer into their own control panel. FREE tier: the "first sale"
// is a $0 receipt plus a portal, no payment, no card, no Stripe. Admin-gated.
//
// POST /api/signup?token=<ADMIN_KEY>   body: { email, site?, name? }
//   -> { ok, email, portalUrl, emailed, tokenReady }
//
// Env: ADMIN_KEY or SWITCH_TOKEN (auth), KS_PANEL_SECRET (link signing),
//      RESEND_API_KEY + optional KS_FROM_EMAIL (the receipt email).
import { onboardCustomer } from '../lib/onboard.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const token = (req.query && req.query.token) || '';
  const authed = [process.env.ADMIN_KEY, process.env.SWITCH_TOKEN].filter(Boolean).includes(token);
  if (!authed) { res.status(401).json({ error: 'unauthorized' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};

  const host = (req.headers && (req.headers.origin || (req.headers.host && ('https://' + req.headers.host)))) || 'https://killswitch.domains';

  let out;
  try {
    out = await onboardCustomer({ email: body.email, site: body.site, name: body.name, host, source: 'operator-onboard' });
  } catch (e) {
    console.error('[signup] error', e);
    res.status(500).json({ error: 'server_error' });
    return;
  }
  if (out.error) { res.status(400).json({ error: out.error }); return; }

  res.status(200).json({
    ok: true, email: out.email, portalUrl: out.portalUrl,
    emailed: out.emailed, tokenReady: out.tokenReady,
    account: { email: out.account.email, site: out.account.site, plan: out.account.plan },
  });
}
