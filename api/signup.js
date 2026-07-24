// Onboard a customer into their own control panel. This is the FREE tier: the
// "first sale" is a $0 receipt plus a portal, no payment and no card, no Stripe.
// Admin-gated for now (the operator onboards each shop by hand); can be opened to
// public self-serve later with rate limiting.
//
// POST /api/signup?token=<ADMIN_KEY>   body: { email, site?, name? }
//   -> creates/updates the account (plan ['P0'])
//   -> emails a $0 receipt + portal link via Resend (if configured)
//   -> returns { ok, email, portalUrl, emailed, tokenReady }
//
// Env: ADMIN_KEY or SWITCH_TOKEN (auth), KS_PANEL_SECRET (link signing),
//      RESEND_API_KEY + optional KS_FROM_EMAIL (the receipt email).
import { upsertAccount } from '../lib/store.js';
import { panelToken } from '../lib/panel-auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const token = (req.query && req.query.token) || '';
  const authed = [process.env.ADMIN_KEY, process.env.SWITCH_TOKEN].filter(Boolean).includes(token);
  if (!authed) { res.status(401).json({ error: 'unauthorized' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};

  const email = String(body.email || '').trim().toLowerCase();
  const site = String(body.site || '').trim();
  const name = String(body.name || '').trim();
  if (!email || email.indexOf('@') < 1) { res.status(400).json({ error: 'valid_email_required' }); return; }

  const host = (req.headers && (req.headers.origin || (req.headers.host && ('https://' + req.headers.host)))) || 'https://killswitch.domains';

  let account;
  try {
    account = await upsertAccount({
      email, name, site,
      plan: ['P0'],                       // free website, always on
      createdAt: new Date().toISOString(),
      source: 'operator-onboard',
    });
  } catch (e) {
    console.error('[signup] store error', e);
    res.status(500).json({ error: 'store_error' });
    return;
  }

  const tok = panelToken(email);
  const portalUrl = host + '/panel?e=' + encodeURIComponent(email) + (tok ? '&t=' + tok : '');

  let emailed = false;
  if (process.env.RESEND_API_KEY && tok) {
    try {
      const from = process.env.KS_FROM_EMAIL || 'KILLSWITCH <hello@killswitch.domains>';
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({
          from,
          to: [email],
          subject: 'Your KILLSWITCH website is live (receipt: $0.00)',
          html: receiptHtml({ name, site, portalUrl }),
        }),
      });
      emailed = r.ok;
      if (!r.ok) console.error('[signup] resend', r.status, await r.text().catch(() => ''));
    } catch (e) { console.error('[signup] email error', e); }
  }

  res.status(200).json({ ok: true, email, portalUrl, emailed, tokenReady: !!tok, account: { email: account.email, site: account.site, plan: account.plan } });
}

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function receiptHtml({ name, site, portalUrl }) {
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#161311">'
    + '<h2 style="margin:0 0 4px">Welcome to KILLSWITCH' + (name ? ', ' + esc(name) : '') + '.</h2>'
    + '<p style="color:#555;margin:0 0 16px">Your website is live and it is yours. Here is your $0 receipt and your control panel.</p>'
    + '<table style="width:100%;border:1px solid #eee;border-radius:10px;border-collapse:separate;overflow:hidden">'
    + '<tr><td style="padding:12px 16px;color:#555">Website &amp; Domain' + (site ? ' (' + esc(site) + ')' : '') + '</td><td style="padding:12px 16px;text-align:right"><b>$0.00</b></td></tr>'
    + '<tr><td style="padding:12px 16px;border-top:1px solid #eee;color:#555">Total today</td><td style="padding:12px 16px;border-top:1px solid #eee;text-align:right"><b>$0.00</b></td></tr>'
    + '</table>'
    + '<p style="margin:20px 0"><a href="' + esc(portalUrl) + '" style="background:#d81f2b;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:700;display:inline-block">Open your control panel</a></p>'
    + '<p style="color:#888;font-size:13px">In your panel you can ask for changes and, whenever you want, flip on paid add-ons like Google visibility or online booking. You only pay for what you switch on, and you can switch it off yourself anytime, it just stops at your next billing date.</p>'
    + '<p style="color:#aaa;font-size:12px">KILLSWITCH · killswitch.domains · a Limen Helix company</p>'
    + '</div>';
}
