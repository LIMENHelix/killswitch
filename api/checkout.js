// Killswitch Websites growth-path multi-select checkout.
// The client posts { phases: ["P1","P3", ...] }; the server maps each phase to
// its MONTHLY subscription price and creates ONE Stripe Checkout Session so the
// customer pays for the whole selection in a single subscription checkout.
// No SDK — calls the Stripe REST API directly via fetch (matches api/chat.js).
// Requires env var STRIPE_SECRET_KEY (already set in the Vercel project).
//
// Prices are looked up server-side by phase code so the client can never set an
// amount. One-time ("or $X once") purchases stay as the per-rung payment links;
// this endpoint only handles the monthly bundle. P0 (free) and P10 (custom) are
// intentionally not buyable here.

const MONTHLY = {
  P1: 'price_1ToXlLPmxnF3rtBM5NRurfkt', // SEO & Local Listings — $19/mo
  P2: 'price_1ToXlrPmxnF3rtBMz3ybz47E', // Content & Email Marketing — $29/mo
  P3: 'price_1ToXlsPmxnF3rtBM9Dc9mDul', // Online Booking & Scheduling — $19/mo
  P4: 'price_1ToXltPmxnF3rtBMvKKaw7vx', // Hosting & Maintenance — $29/mo
  P5: 'price_1ToXluPmxnF3rtBMEleF5u3D', // CRM & Customer Database — $29/mo
  P6: 'price_1ToXlvPmxnF3rtBM7aDkUq1Y', // Marketing Automation — $29/mo
  P7: 'price_1ToXlwPmxnF3rtBMfqIS7WEs', // Payments & Checkout — $19/mo
  P8: 'price_1ToXlyPmxnF3rtBMendZWgMs', // Analytics & Reporting — $19/mo
  P9: 'price_1ToXlzPmxnF3rtBMv1DlSFC5', // 24/7 AI Assistant — $29/mo
};

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
  const priceIds = [];
  const seen = {};
  for (const p of phases) {
    const id = MONTHLY[p];
    if (id && !seen[id]) { seen[id] = true; priceIds.push(id); }
  }
  if (!priceIds.length) {
    res.status(400).json({ error: 'no_valid_phases' });
    return;
  }

  const host = (req.headers && (req.headers.origin || (req.headers.host && ('https://' + req.headers.host)))) || 'https://killswitchwebsites.com';

  const params = new URLSearchParams();
  params.append('mode', 'subscription');
  params.append('success_url', host + '/pricing?checkout=success');
  params.append('cancel_url', host + '/pricing?checkout=cancel');
  params.append('allow_promotion_codes', 'true');
  params.append('billing_address_collection', 'auto');
  priceIds.forEach((id, i) => {
    params.append('line_items[' + i + '][price]', id);
    params.append('line_items[' + i + '][quantity]', '1');
  });

  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.url) {
      console.error('[killswitch checkout] stripe error', r.status, data && data.error);
      res.status(502).json({ error: (data && data.error && data.error.message) || 'stripe_error' });
      return;
    }
    res.status(200).json({ url: data.url });
  } catch (e) {
    console.error('[killswitch checkout] error', e);
    res.status(500).json({ error: 'server_error' });
  }
}
