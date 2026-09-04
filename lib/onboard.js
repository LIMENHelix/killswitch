// Shared customer onboarding (free tier, the $0 "sale"). Creates/updates the
// account with plan ['P0'], mints the passwordless portal link, and emails the
// $0 receipt via Resend. Used by both /api/signup and /api/master so there is
// one code path.
import { getAccount, upsertAccount } from './store.js';
import { panelToken } from './panel-auth.js';
import { recordEnrollment } from './funnel.js';
import { PHASE_LABEL, notifyOperator } from './notify.js';
import { linkAccountToSite } from './site-link.js';
import { publicOrigin } from './origin.js';
import { externalSideEffectsAllowed } from './environment.js';

export async function onboardCustomer({ email, site, name, phone, source, leadId, dealCents }) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || e.indexOf('@') < 1) return { error: 'valid_email_required' };

  const existing = await getAccount(e);
  const patch = { email: e };
  // Signup may be repeated after a purchase or from another page. Fill missing
  // identity fields, but never reset an existing plan, creation date, source,
  // Stripe link, or customer-entered business details.
  if (!existing) {
    Object.assign(patch, {
      name: String(name || '').trim(),
      site: String(site || '').trim(),
      phone: String(phone || '').trim(),
      plan: ['P0'],
      createdAt: new Date().toISOString(),
      source: source || 'onboard',
    });
  } else {
    if (!existing.name && name) patch.name = String(name).trim();
    if (!existing.site && site) patch.site = String(site).trim();
    if (!existing.phone && phone) patch.phone = String(phone).trim();
  }
  const account = await upsertAccount(patch);

  // JOIN THE ACCOUNT TO ITS SITE, HERE, WHILE WE STILL KNOW THE BUSINESS NAME.
  //
  // Onboarding used to create the account and stop, leaving the account-to-site
  // join to happen by luck: someone had to have typed the business name into
  // /master the same way it was typed here, because the only thing tying the two
  // together is a slug derived from that text. When it did not match, every
  // later syncModules() found nothing and returned null, and every caller
  // ignored it. This makes the join explicitly, once, at the only moment we hold
  // both halves. See lib/site-link.js for why it will not steal someone else's
  // record and why it creates nothing.
  const link = await linkAccountToSite({ email: e, site: account.site, name: account.name });

  const tok = await panelToken(e);
  const base = publicOrigin();
  const portalUrl = base + '/panel?e=' + encodeURIComponent(e) + (tok ? '&t=' + tok : '');

  let emailed = false;
  if (externalSideEffectsAllowed() && process.env.RESEND_API_KEY && tok) {
    try {
      const from = process.env.KS_FROM_EMAIL || 'Killswitch Websites <hello@killswitch.domains>';
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({
          from, to: [e],
          subject: link.live
            ? 'Your Killswitch Websites website is live (receipt: $0.00)'
            : 'Your Killswitch Websites account is set up (receipt: $0.00)',
          html: receiptHtml({ name: account.name, site: account.site, portalUrl, live: link.live }),
        }),
      });
      emailed = r.ok;
      if (!r.ok) console.error('[onboard] resend', r.status, await r.text().catch(() => ''));
    } catch (err) { console.error('[onboard] email error', err); }
  }

  // AN ENROLLMENT, observed rather than clicked. Taking the free site is a real
  // conversion at a zero deal size, which is exactly how the operator described
  // `won`. Fire and forget so a funnel write can never block a delivery.
  if (leadId) {
    recordEnrollment(leadId, dealCents || 0).catch((err) => console.error('[onboard] recordEnrollment', err));
  }

  // THE RECEIPT ABOVE SAYS "Your website is live and it is yours." If the join
  // failed, that sentence is not true yet, and the customer has just been told it
  // is. The mail still goes, because holding it would leave them with no panel
  // link at all, but you get told the same minute so it can be true within the
  // hour. `owned_by_other` is the one to read carefully: a site with that slug
  // exists and belongs to somebody else.
  if (!link.linked) {
    console.error('[onboard] NO SITE JOINED', e, link.reason, link.slug || '');
    await notifyOperator({
      subject: `New customer with no website attached - ${e}`,
      heading: 'Onboarding finished but no site record is joined to this account',
      lines: [
        `Customer: ${account.name || e}`,
        `Email: ${e}`,
        `They typed: ${account.site || '(nothing)'}`,
        `Reason: ${link.reason}${link.slug ? ' (slug ' + link.slug + ')' : ''}`,
        link.reason === 'owned_by_other'
          ? 'A site with that name already belongs to a different email, so nothing was changed. Check which of them is right before touching it.'
          : link.reason === 'ambiguous'
            ? 'More than one existing site could be theirs and nothing was changed, because picking the wrong one would put another business on their page. Say which is right.'
            : 'Nothing they switch on will render anywhere until a site record carries this email address.',
        'Their welcome email did NOT claim their website is live, so nothing untrue has been sent. It says you are putting it together and they will hear from you, which is now a promise with your name on it.',
      ],
      url: publicOrigin() + '/master', urlText: 'Open Master Panel',
    });
  }

  return { ok: true, email: e, portalUrl, emailed, tokenReady: !!tok, account, link };
}

/**
 * Email someone the link to their own control panel.
 *
 * Kept separate from the $0 welcome above because that one opens with "Your
 * website is live and it is yours", which is true for a free-site customer and
 * a lie to someone who just picked modules off the pricing page and has no site
 * yet. Same panel, different truth, so different words.
 *
 * Never throws: it is called on the checkout path and a mail failure must not
 * cost the sale.
 * @returns {Promise<boolean>} whether it was actually sent
 */
export async function sendPanelLink({ email, portalUrl, phases = [] }) {
  const e = String(email || '').trim().toLowerCase();
  if (!externalSideEffectsAllowed()) return false;
  if (!process.env.RESEND_API_KEY || !e || !portalUrl) return false;
  const picked = (phases || []).map((p) => PHASE_LABEL[p] || p).filter(Boolean);
  try {
    const from = process.env.KS_FROM_EMAIL || 'Killswitch Websites <hello@killswitch.domains>';
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        from, to: [e],
        subject: 'Your Killswitch Websites control panel',
        html: '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#161311">'
          + '<h2 style="margin:0 0 4px">Here is your control panel.</h2>'
          + '<p style="color:#555;margin:0 0 16px">This link is yours. Keep it: it is how you switch things on and off, and there is no password to remember.</p>'
          + (picked.length
            ? '<p style="color:#555;margin:0 0 16px">You were checking out with: <b>' + esc(picked.join(', ')) + '</b>. Anything you paid for appears switched on here once the payment goes through.</p>'
            : '')
          + '<p style="margin:20px 0"><a href="' + esc(portalUrl) + '" style="background:#d81f2b;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:700;display:inline-block">Open your control panel</a></p>'
          + '<p style="color:#888;font-size:13px">If you closed the payment window before it finished, nothing was charged. Open the panel whenever you want to pick this back up.</p>'
          + '<p style="color:#aaa;font-size:12px">Killswitch Websites &middot; killswitchwebsites.com &middot; a Limen Helix company</p>'
          + '</div>',
      }),
    });
    if (!r.ok) console.error('[onboard] panel link resend', r.status, await r.text().catch(() => ''));
    return r.ok;
  } catch (err) { console.error('[onboard] panel link error', err); return false; }
}

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

/**
 * @param {boolean} live whether a published site is actually joined to this
 *   account. THIS MAIL USED TO CLAIM IT UNCONDITIONALLY. `published:false` is a
 *   hard 404, and an account with no site record joined to it has no page at
 *   all, so "Your website is live" was a written promise the system had not
 *   kept in either case. It now says the true one of the two, and the operator
 *   gets told the moment the second one goes out.
 */
function receiptHtml({ name, site, portalUrl, live }) {
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#161311">'
    + '<h2 style="margin:0 0 4px">Welcome to Killswitch Websites' + (name ? ', ' + esc(name) : '') + '.</h2>'
    + '<p style="color:#555;margin:0 0 16px">'
    + (live
      ? 'Your website is live and it is yours. Here is your $0 receipt and your control panel.'
      : 'Your account is set up and your control panel is ready. We are putting your website together now and you will hear from us the moment it is up. Here is your $0 receipt.')
    + '</p>'
    + '<table style="width:100%;border:1px solid #eee;border-radius:10px;border-collapse:separate;overflow:hidden">'
    + '<tr><td style="padding:12px 16px;color:#555">Website &amp; Domain' + (site ? ' (' + esc(site) + ')' : '') + '</td><td style="padding:12px 16px;text-align:right"><b>$0.00</b></td></tr>'
    + '<tr><td style="padding:12px 16px;border-top:1px solid #eee;color:#555">Total today</td><td style="padding:12px 16px;border-top:1px solid #eee;text-align:right"><b>$0.00</b></td></tr>'
    + '</table>'
    + '<p style="margin:20px 0"><a href="' + esc(portalUrl) + '" style="background:#d81f2b;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:700;display:inline-block">Open your control panel</a></p>'
    + '<p style="color:#888;font-size:13px">In your panel you can ask for changes and, whenever you want, flip on paid add-ons like Google visibility or online booking. You only pay for what you switch on, and you can switch it off yourself anytime.</p>'
    + '<p style="color:#aaa;font-size:12px">Killswitch Websites · killswitchwebsites.com · a Limen Helix company</p>'
    + '</div>';
}
