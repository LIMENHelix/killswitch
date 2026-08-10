// Killswitch Websites growth-path multi-select checkout, from the public page.
// The client posts { email, phases: ["P1","P3", ...] }; the server maps each
// phase to its MONTHLY subscription price and creates ONE Stripe Checkout
// Session so the customer pays for the whole selection at once.
//
// THIS ENDPOINT USED TO TAKE MONEY AND PROVISION NOTHING. It created the
// subscription and sent the browser to /pricing?checkout=success, which is a
// static page. No account was made, no panel link was sent, the modules were
// never switched on for them, and the operator was never told. There is no
// Stripe webhook in this project either, so nothing caught it afterwards: a
// customer who bought here was invisible until somebody happened to read a
// Stripe email. The panel had a complete, working version of all of this.
//
// So this path now joins that one instead of running beside it:
//   1. an email is REQUIRED, because nothing can be provisioned without one
//   2. an account exists before Stripe is called, so there is a panel to return to
//   3. success_url is that panel, carrying session_id, which is exactly what
//      api/switch.js `link` consumes to attach the Stripe customer, switch the
//      paid modules onto their live site, and send the PAID notification
//   4. the panel link is emailed up front, so closing the tab on Stripe's
//      receipt page is survivable: opening that link later runs ensureLinked,
//      which finds the payment and repairs the account by itself
//
// Prices are looked up server-side by phase code so the client can never set an
// amount. One-time ("or $X once") purchases stay as the per-rung payment links;
// this endpoint only handles the monthly bundle. P0 (free) and P10 (custom) are
// intentionally not buyable here.

// One source of truth for what a module costs and whether it can be sold at all.
// This file used to keep its own copy of the price map, which is how P5 and P6
// stayed purchasable here after being pulled from the pricing page.
import { MONTHLY, isSellable } from '../lib/prices.js';
import { getAccount, upsertAccount } from '../lib/store.js';
import { panelToken } from '../lib/panel-auth.js';
import { sendPanelLink } from '../lib/onboard.js';
import { notifyOperator, labelPhases } from '../lib/notify.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    res.status(503).json({ error: 'not_configured' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};

  const phases = Array.isArray(body.phases) ? body.phases : [];

  // A retired module is refused OUTRIGHT rather than quietly dropped from the
  // basket. Silently ignoring it would charge for the rest of the selection
  // while the customer believed they had bought all of it.
  const retired = phases.filter((p) => MONTHLY[p] && !isSellable(p));
  if (retired.length) {
    res.status(400).json({ error: 'not_for_sale', phases: retired });
    return;
  }

  const priceIds = [];
  const seen = {};
  for (const p of phases) {
    if (!isSellable(p)) continue;
    const id = MONTHLY[p];
    if (id && !seen[id]) { seen[id] = true; priceIds.push(id); }
  }
  if (!priceIds.length) {
    res.status(400).json({ error: 'no_valid_phases' });
    return;
  }

  // NO EMAIL, NO SALE. Without one there is no account, no panel, and no way to
  // switch on what they just bought, which is precisely the state this endpoint
  // used to leave every customer in. Checked AFTER the basket, so someone asking
  // for something we do not sell is told that, rather than being asked for an
  // address first and refused afterwards.
  const email = String(body.email || '').trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    res.status(400).json({ error: 'email_required' });
    return;
  }

  const host = (req.headers && (req.headers.origin || (req.headers.host && ('https://' + req.headers.host)))) || 'https://killswitchwebsites.com';

  // THE ACCOUNT COMES FIRST, before Stripe is touched, so there is somewhere for
  // the payment to land. An existing customer is left exactly as they are: an
  // upsert here would merge plan:['P0'] over a real account, and buying an
  // upgrade must never quietly rewrite what someone already has.
  let account;
  try {
    account = await getAccount(email);
    if (!account) {
      account = await upsertAccount({
        email, plan: ['P0'], createdAt: new Date().toISOString(), source: 'pricing-checkout',
      });
    }
  } catch (e) {
    console.error('[checkout] account', e);
    res.status(500).json({ error: 'server_error' });
    return;
  }

  const tok = panelToken(email);
  const back = '/panel?e=' + encodeURIComponent(email) + (tok ? '&t=' + tok : '');

  const params = new URLSearchParams();
  params.append('mode', 'subscription');
  // Land them in their own panel with the session id, which is the trigger for
  // api/switch.js `link`: attach the Stripe customer, switch the paid modules
  // onto their live site, notify the operator that money moved.
  params.append('success_url', host + back + '&session_id={CHECKOUT_SESSION_ID}');
  params.append('cancel_url', host + '/pricing?checkout=cancel');
  params.append('allow_promotion_codes', 'true');
  params.append('billing_address_collection', 'auto');
  // Reuse their Stripe customer when we know it, so an existing customer does
  // not end up with a second customer object and a split billing history.
  if (account.stripeCustomerId) params.append('customer', account.stripeCustomerId);
  else params.append('customer_email', email);
  priceIds.forEach((id, i) => {
    params.append('line_items[' + i + '][price]', id);
    params.append('line_items[' + i + '][quantity]', '1');
  });

  let data;
  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    data = await r.json().catch(() => ({}));
    if (!r.ok || !data.url) {
      console.error('[killswitch checkout] stripe error', r.status, data && data.error);
      res.status(502).json({ error: (data && data.error && data.error.message) || 'stripe_error' });
      return;
    }
  } catch (e) {
    console.error('[killswitch checkout] error', e);
    res.status(500).json({ error: 'server_error' });
    return;
  }

  // Send the panel link BEFORE they pay, deliberately. If they finish checkout
  // they get there by redirect anyway; the case this covers is the one that used
  // to lose people entirely, where the card is charged and the tab is closed on
  // Stripe's receipt page. Opening this link at any point afterwards runs
  // ensureLinked, which finds the payment and repairs the account unaided.
  // Awaited but never fatal: a mail failure must not cost us the sale.
  const selected = phases.filter(isSellable);
  try {
    await sendPanelLink({ email, portalUrl: host + back, phases: selected });
  } catch (e) { console.error('[checkout] panel link email', e); }

  await notifyOperator({
    subject: `Checkout started - ${email}`,
    heading: 'Someone is buying from the pricing page',
    lines: [
      `Email: ${email}`,
      `Modules: ${labelPhases(selected)}`,
      'This is the START of a checkout, not a payment. A separate PAID email',
      'follows if they finish. If it never arrives, they did not complete it.',
    ],
    url: host + '/master', urlText: 'Open Master Panel',
  });

  res.status(200).json({ url: data.url });
}
