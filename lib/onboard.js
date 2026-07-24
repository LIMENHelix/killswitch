// Shared customer onboarding (free tier, the $0 "sale"). Creates/updates the
// account with plan ['P0'], mints the passwordless portal link, and emails the
// $0 receipt via Resend. Used by both /api/signup and /api/master so there is
// one code path.
import { upsertAccount } from './store.js';
import { panelToken } from './panel-auth.js';

export async function onboardCustomer({ email, site, name, host, source }) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || e.indexOf('@') < 1) return { error: 'valid_email_required' };

  const account = await upsertAccount({
    email: e,
    name: String(name || '').trim(),
    site: String(site || '').trim(),
    plan: ['P0'],
    createdAt: new Date().toISOString(),
    source: source || 'onboard',
  });

  const tok = panelToken(e);
  const base = host || 'https://killswitch.domains';
  const portalUrl = base + '/panel?e=' + encodeURIComponent(e) + (tok ? '&t=' + tok : '');

  let emailed = false;
  if (process.env.RESEND_API_KEY && tok) {
    try {
      const from = process.env.KS_FROM_EMAIL || 'KILLSWITCH <hello@killswitch.domains>';
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({
          from, to: [e],
          subject: 'Your KILLSWITCH website is live (receipt: $0.00)',
          html: receiptHtml({ name: account.name, site: account.site, portalUrl }),
        }),
      });
      emailed = r.ok;
      if (!r.ok) console.error('[onboard] resend', r.status, await r.text().catch(() => ''));
    } catch (err) { console.error('[onboard] email error', err); }
  }

  return { ok: true, email: e, portalUrl, emailed, tokenReady: !!tok, account };
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
    + '<p style="color:#888;font-size:13px">In your panel you can ask for changes and, whenever you want, flip on paid add-ons like Google visibility or online booking. You only pay for what you switch on, and you can switch it off yourself anytime.</p>'
    + '<p style="color:#aaa;font-size:12px">KILLSWITCH · killswitch.domains · a Limen Helix company</p>'
    + '</div>';
}
