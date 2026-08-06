// Master Panel backend (operator/customer cockpit). Admin-gated.
// POST /api/master  body: { action, token, ... }
//   action 'list'    -> { accounts:[...], totals:{customers,paying,mrr}, stripe:bool }
//   action 'onboard' -> { ok, email, portalUrl, emailed }  (creates a free account + $0 receipt)
//
// MRR/switch data is read live from Stripe on each load, so it is always
// accurate with no sync to maintain. Free accounts (no Stripe) show plan P0.
import { getAccounts, upsertAccount } from '../lib/store.js';
import { onboardCustomer } from '../lib/onboard.js';
import { panelToken } from '../lib/panel-auth.js';
import { getSites, getSite, upsertSite, slugify } from '../lib/sites.js';

// Everything the website editor is allowed to write. A save applies ONLY the
// keys it was actually sent, so a partial save is a partial update. This used to
// pass all of them unconditionally, and site-list returns a summary rather than
// the full record, so opening an existing customer and saving wrote blanks over
// their phone, address, hours, services and about text. Use site-get to load.
const SITE_FIELDS = [
  'email', 'business', 'trade', 'tagline', 'phone', 'email_public',
  'street', 'city', 'state', 'zip', 'about', 'accent', 'bookingUrl', 'payUrl',
];
const SITE_ARRAYS = ['hours', 'services', 'posts', 'modules'];

const PRICE_LABEL = {
  price_1ToXlLPmxnF3rtBM5NRurfkt: 'Get Found on Google',
  price_1ToXlrPmxnF3rtBMz3ybz47E: 'Content & Email',
  price_1ToXlsPmxnF3rtBM9Dc9mDul: 'Online Booking',
  price_1ToXltPmxnF3rtBMvKKaw7vx: 'Hosting & Maintenance',
  price_1ToXluPmxnF3rtBMEleF5u3D: 'CRM',
  price_1ToXlvPmxnF3rtBM7aDkUq1Y: 'Marketing Automation',
  price_1ToXlwPmxnF3rtBMfqIS7WEs: 'Payments',
  price_1ToXlyPmxnF3rtBMendZWgMs: 'Analytics',
  price_1ToXlzPmxnF3rtBMv1DlSFC5: '24/7 AI Assistant',
  price_1TnMiMPmxnF3rtBMgqTJpLh6: 'Care Plan',
};

async function stripeGet(path) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  const r = await fetch('https://api.stripe.com/v1' + path, {
    headers: { Authorization: 'Bearer ' + key },
  });
  if (!r.ok) { console.error('[master] stripe', path, r.status); return null; }
  return r.json().catch(() => null);
}

// customerId -> { mrr (dollars), switches:[label], renewsAt, endsAt } from active subs.
//
// PAGINATES. Stripe caps a page at 100 and this used to request limit=100 with no
// has_more loop, so past 100 active subscriptions the MRR silently under-reported
// and paying customers rendered as free. It failed quietly, which is the worst
// way to fail. MAX_PAGES bounds the function's runtime; if it is ever hit the
// result is flagged truncated rather than pretending to be complete.
const MAX_PAGES = 25; // 2,500 subscriptions

async function stripeByCustomer() {
  const out = {};
  const byEmail = {}; // lowercased email -> stripe customer id, for self-healing
  let startingAfter = null, pages = 0, truncated = false;

  for (;;) {
    // expand the customer so we get their email in the SAME call. That is what
    // lets us repair an account whose payment was never linked, at no extra cost.
    const q = '/subscriptions?status=active&limit=100&expand[]=data.customer' + (startingAfter ? '&starting_after=' + startingAfter : '');
    const subs = await stripeGet(q);
    if (!subs || !Array.isArray(subs.data)) break;

    for (const s of subs.data) {
      const cust = typeof s.customer === 'string' ? s.customer : (s.customer && s.customer.id);
      if (!cust) continue;
      const cEmail = (s.customer && typeof s.customer === 'object' && s.customer.email) ? String(s.customer.email).trim().toLowerCase() : '';
      if (cEmail && !byEmail[cEmail]) byEmail[cEmail] = cust;
      const rec = (out[cust] = out[cust] || { mrr: 0, switches: [], renewsAt: null, endsAt: null });
      const items = (s.items && s.items.data) || [];
      for (const it of items) {
        const p = it.price || {};
        const monthly = p.recurring && p.recurring.interval === 'month' ? (p.unit_amount || 0) : 0;
        rec.mrr += monthly / 100;
        const label = PRICE_LABEL[p.id] || (p.nickname || 'Add-on');
        if (!rec.switches.includes(label)) rec.switches.push(label);
        // same source api/switch.js uses: Stripe moved period end onto the line item
        const per = it.current_period_end || s.current_period_end || null;
        if (per && (!rec.renewsAt || per < rec.renewsAt)) rec.renewsAt = per;
        // cancel_at_period_end means it is winding down: that date is an END, not a renewal
        if (s.cancel_at_period_end && per && (!rec.endsAt || per < rec.endsAt)) rec.endsAt = per;
      }
    }

    pages++;
    if (!subs.has_more || !subs.data.length) break;
    if (pages >= MAX_PAGES) { truncated = true; break; }
    startingAfter = subs.data[subs.data.length - 1].id;
  }

  Object.defineProperty(out, '__truncated', { value: truncated, enumerable: false });
  Object.defineProperty(out, '__byEmail', { value: byEmail, enumerable: false });
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};

  const authed = [process.env.ADMIN_KEY, process.env.SWITCH_TOKEN].filter(Boolean).includes(body.token);
  if (!authed) { res.status(401).json({ error: 'unauthorized' }); return; }

  const action = body.action || 'list';

  try {
    if (action === 'onboard') {
      const host = (req.headers && (req.headers.origin || (req.headers.host && ('https://' + req.headers.host)))) || 'https://killswitchwebsites.com';
      const out = await onboardCustomer({ email: body.email, site: body.site, name: body.name, host, source: 'master-onboard' });
      if (out.error) { res.status(400).json({ error: out.error }); return; }
      res.status(200).json({ ok: true, email: out.email, portalUrl: out.portalUrl, emailed: out.emailed, tokenReady: out.tokenReady });
      return;
    }

    // ---- one-template site records ----
    if (action === 'site-list') {
      const m = await getSites();
      const sites = Object.values(m).map((s) => ({
        slug: s.slug, business: s.business, email: s.email || '', trade: s.trade || '',
        published: !!s.published, modules: s.modules || ['P0'],
      })).sort((a, b) => a.business.localeCompare(b.business));
      res.status(200).json({ ok: true, sites });
      return;
    }
    // The FULL record, for loading into the editor. Without this the editor can
    // only ever be used to create, because everything it did not receive it
    // silently blanked on the next save.
    if (action === 'site-get') {
      const s = await getSite(body.slug);
      if (!s) { res.status(404).json({ error: 'not_found' }); return; }
      res.status(200).json({ ok: true, site: s });
      return;
    }

    if (action === 'site-save') {
      const p = body.site || {};
      if (!p.business && !p.slug) { res.status(400).json({ error: 'business_required' }); return; }

      const patch = { slug: slugify(p.slug || p.business) };
      for (const f of SITE_FIELDS) if (Object.prototype.hasOwnProperty.call(p, f)) patch[f] = p[f];
      for (const f of SITE_ARRAYS) if (Array.isArray(p[f])) patch[f] = p[f];
      if (p.published !== undefined) patch.published = !!p.published;

      const saved = await upsertSite(patch);
      res.status(200).json({ ok: true, site: saved, url: '/s/' + saved.slug });
      return;
    }

    // action 'list'
    const host = (req.headers && (req.headers.origin || (req.headers.host && ('https://' + req.headers.host)))) || 'https://killswitchwebsites.com';
    const map = await getAccounts();
    const byCust = await stripeByCustomer();

    // SELF-HEAL. A customer who paid and then closed the tab never came back to
    // success_url, so api/switch.js link() never ran and their account still says
    // free while Stripe charges them. Stripe just told us which emails hold an
    // active subscription, so any account that matches one and is not linked gets
    // linked now, before this page renders a number that would be wrong.
    const repaired = [];
    for (const k of Object.keys(map)) {
      const a = map[k];
      if (a.stripeCustomerId) continue;
      const cust = byCust.__byEmail[String(a.email || '').trim().toLowerCase()];
      if (!cust) continue;
      a.stripeCustomerId = cust;
      repaired.push(upsertAccount({ email: a.email, stripeCustomerId: cust }));
    }
    if (repaired.length) {
      await Promise.all(repaired);
      console.log('[master] linked', repaired.length, 'account(s) whose payment was never recorded');
    }

    const accounts = Object.keys(map).map((k) => {
      const a = map[k];
      const s = (a.stripeCustomerId && byCust[a.stripeCustomerId]) || null;
      const tok = panelToken(a.email);
      return {
        email: a.email,
        name: a.name || '',
        site: a.site || '',
        plan: Array.isArray(a.plan) ? a.plan : ['P0'],
        createdAt: a.createdAt || '',
        linked: !!a.stripeCustomerId,
        mrr: s ? +s.mrr.toFixed(2) : 0,
        switches: s ? s.switches : [],
        renewsAt: s ? s.renewsAt : null,   // unix seconds, next charge
        endsAt: s ? s.endsAt : null,       // unix seconds, winding down (cancel_at_period_end)
        portalUrl: host + '/panel?e=' + encodeURIComponent(a.email) + (tok ? '&t=' + tok : ''),
      };
    }).sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));

    const totals = {
      customers: accounts.length,
      paying: accounts.filter((a) => a.mrr > 0).length,
      mrr: +accounts.reduce((n, a) => n + a.mrr, 0).toFixed(2),
      ending: accounts.filter((a) => a.endsAt).length,
    };
    res.status(200).json({
      ok: true, accounts, totals,
      stripe: !!process.env.STRIPE_SECRET_KEY,
      truncated: !!byCust.__truncated, // true = more subs than we read; MRR is a floor, not a total
    });
  } catch (e) {
    console.error('[master] error', e);
    res.status(500).json({ error: 'server_error' });
  }
}
