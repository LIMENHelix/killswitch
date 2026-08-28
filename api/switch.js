// Phase 2 billing engine for the customer panel. BATCH: the panel sends the full
// desired set of paid switches ("on") and the server reconciles it against Stripe
// in one shot, add what's newly on, stop what's newly off, one checkout for all
// first-time adds. Each customer keeps ONE subscription with a line item per
// switch. Turning a switch off removes its item with no proration (the current
// paid cycle is kept, no new charge next cycle); turning off everything cancels
// the subscription at period end. "ending" (off but paid through a date) is shown
// from a small per-account map so the promise stays visible.
import { getAccount, upsertAccount } from '../lib/store.js';
import { verifyPanel, panelToken } from '../lib/panel-auth.js';
import { MONTHLY, PRICE_TO_PHASE, isSellable } from '../lib/prices.js';
import { stripeGet, stripePost, stripeDelete } from '../lib/stripe.js';
import { notifyOperator, labelPhases } from '../lib/notify.js';
import { siteForEmail, upsertSite } from '../lib/sites.js';
// syncModulesLoud, not syncModules: a paid switch that renders nowhere used to
// return null into a catch that only ever saw thrown errors. See lib/site-link.js.
import { syncModulesLoud } from '../lib/site-link.js';
import { getStats } from '../lib/stats.js';
import { listContacts, updateContact, summarise } from '../lib/crm.js';
import { statsFor } from '../lib/automation.js';
import { ensureLinked, liveSubs } from '../lib/entitle.js';

const LIVE_STATUSES = ['active', 'trialing', 'past_due'];

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};

  const email = String(body.e || '').trim().toLowerCase();
  const token = String(body.t || '');
  if (!await verifyPanel(email, token)) { res.status(401).json({ error: 'unauthorized' }); return; }

  const found = await getAccount(email);
  if (!found) { res.status(404).json({ error: 'not_found' }); return; }

  const host = (req.headers && (req.headers.origin || (req.headers.host && ('https://' + req.headers.host)))) || 'https://killswitchwebsites.com';

  // Repair a payment that never got recorded. A customer who paid on Stripe and
  // then closed the tab never hit success_url, so link() below never ran and this
  // account still looks free while their card is being charged. Reading their
  // panel now finds it and attaches it. Costs nothing on an account already linked.
  const account = await ensureLinked(found, host);

  // If that repaired the link, the site never got told what they bought either.
  // Catch it up here, once, on the first panel load after the lost payment.
  if (account.stripeCustomerId && account.stripeCustomerId !== found.stripeCustomerId) {
    try { await syncModulesLoud(email, Object.keys(itemsByPhase(await liveSubs(account.stripeCustomerId))), 'panel-load-repair'); }
    catch (err) { console.error('[switch] repair site sync', err); }
  }
  const action = body.action || 'state';

  try {
    if (action === 'state') { res.status(200).json(await readState(account)); return; }
    if (action === 'stats') { res.status(200).json(await readStats(account)); return; }
    if (action === 'crm') { res.status(200).json(await readCrm(account)); return; }
    if (action === 'crm-update') { res.status(200).json(await writeCrm(account, body)); return; }
    if (action === 'apply') { res.status(200).json(await applyChanges(account, body.on, host, email)); return; }
    if (action === 'link')  { res.status(200).json(await link(account, body.session_id, host)); return; }
    res.status(400).json({ error: 'unknown_action' });
  } catch (err) {
    console.error('[switch]', action, err);
    res.status(500).json({ error: 'server_error' });
  }
}

// liveSubs now lives in lib/entitle.js so the panel, the support desk and the
// master board all decide "is this customer paying for X" the same way.

function itemsByPhase(subs) {
  const map = {};
  for (const s of subs) {
    for (const it of (s.items && s.items.data) || []) {
      const phase = PRICE_TO_PHASE[it.price && it.price.id];
      if (!phase) continue;
      map[phase] = { subId: s.id, itemId: it.id, endsAt: it.current_period_end || s.current_period_end || null, cancelAtEnd: !!s.cancel_at_period_end };
    }
  }
  return map;
}

async function readState(account) {
  const subs = await liveSubs(account.stripeCustomerId);
  const items = itemsByPhase(subs);
  const now = Math.floor(Date.now() / 1000);
  const ending = account.ending || {};
  const modules = {};
  for (const phase of Object.keys(items)) {
    modules[phase] = { state: items[phase].cancelAtEnd ? 'ending' : 'active', endsAt: items[phase].endsAt };
  }
  for (const phase of Object.keys(ending)) {
    if (modules[phase]) continue;
    if (ending[phase] && ending[phase] > now) modules[phase] = { state: 'ending', endsAt: ending[phase] };
  }
  // THE SITE THEY ARE ACTUALLY PAYING US ABOUT. `account.site` is a string
  // somebody typed at signup, so it can be a domain that does not resolve, a
  // business name, or nothing. This is the record itself, which is the only
  // thing that answers "where is my website" truthfully, and the same lookup
  // that decides whether flipping a switch changes anything.
  let live = null;
  try {
    const rec = await siteForEmail(account.email);
    if (rec) {
      // AUTO-CLAIM on first panel load: customer opened their panel, so they own it.
      // Published sites stay published and get indexed. Unpublished draft 404s until
      // they claim it themselves (which this does), so nothing changes visibility.
      if (!rec.claimed) {
        try {
          await upsertSite({ slug: rec.slug, claimed: true });
          rec.claimed = true;
        } catch (e) { console.error('[switch] auto-claim', rec.slug, e); }
      }
      live = { slug: rec.slug, path: '/s/' + rec.slug, published: !!rec.published, claimed: !!rec.claimed };
    }
  } catch (e) { console.error('[switch] site lookup', e); }

  return {
    site: account.site || '', name: account.name || '', linked: !!account.stripeCustomerId, modules,
    // Only a PUBLISHED record gets a path: api/site.js 404s a draft, and
    // sending a customer to their own broken link is worse than saying nothing.
    siteUrl: live && live.published ? live.path : '',
    siteSlug: live ? live.slug : '',
    sitePublished: !!(live && live.published),
  };
}

// P8 is the only module the customer cannot see working from their own site, so
// this is where it becomes visible. Entitlement is read from Stripe, not from
// the site record, so switching P8 off stops the numbers with the billing.
async function readStats(account) {
  const subs = await liveSubs(account.stripeCustomerId);
  const phases = new Set(Object.keys(itemsByPhase(subs)));
  if (!phases.has('P8')) return { entitled: false };

  const site = await siteForEmail(account.email);
  if (!site) return { entitled: true, stats: null };
  return { entitled: true, slug: site.slug, stats: await getStats(site.slug) };
}

// ---- P5 CRM + P6 automation, both read from Stripe like everything else ----
async function paidPhases(account) {
  return new Set(Object.keys(itemsByPhase(await liveSubs(account.stripeCustomerId))));
}

async function readCrm(account) {
  const phases = await paidPhases(account);
  if (!phases.has('P5')) return { entitled: false };

  const site = await siteForEmail(account.email);
  if (!site) return { entitled: true, contacts: [], summary: summarise([]) };

  const contacts = await listContacts(site.slug);
  return {
    entitled: true, slug: site.slug, contacts, summary: summarise(contacts),
    // The automation panel rides along, because "what is queued to go out to
    // these people" belongs next to the people, not on a screen of its own.
    automation: phases.has('P6') ? await statsFor(site.slug) : null,
  };
}

async function writeCrm(account, body) {
  const phases = await paidPhases(account);
  if (!phases.has('P5')) return { error: 'not_entitled' };
  const site = await siteForEmail(account.email);
  if (!site) return { error: 'no_site' };

  const rec = await updateContact(site.slug, String(body.id || ''), {
    status: body.status, note: body.note,
  });
  if (!rec) return { error: 'not_found' };
  return { ok: true, contact: rec };
}

async function applyChanges(account, on, host, email) {
  const desired = new Set((Array.isArray(on) ? on : []).filter((p) => MONTHLY[p]));
  let subs = await liveSubs(account.stripeCustomerId);
  let items = itemsByPhase(subs);
  const ending = { ...(account.ending || {}) };
  const now = Math.floor(Date.now() / 1000);
  const turnedOff = []; // confirmed removals, for the operator notification

  // 1) Reactivate any cancel-at-period-end subscription holding a desired phase.
  const uncancel = new Set();
  for (const phase of Object.keys(items)) if (desired.has(phase) && items[phase].cancelAtEnd) uncancel.add(items[phase].subId);
  for (const subId of uncancel) await stripePost('/subscriptions/' + subId, { cancel_at_period_end: false });
  if (uncancel.size) { subs = await liveSubs(account.stripeCustomerId); items = itemsByPhase(subs); }

  // 2) Removals, grouped per subscription so removing all of one cancels it cleanly.
  const bySub = {};
  for (const phase of Object.keys(items)) {
    if (items[phase].cancelAtEnd) continue; // already ending
    const g = (bySub[items[phase].subId] = bySub[items[phase].subId] || { endsAt: items[phase].endsAt, phases: [] });
    g.phases.push(phase);
  }
  for (const subId of Object.keys(bySub)) {
    const g = bySub[subId];
    const remove = g.phases.filter((p) => !desired.has(p));
    if (!remove.length) continue;
    if (remove.length === g.phases.length) {
      const r = await stripePost('/subscriptions/' + subId, { cancel_at_period_end: true });
      if (!r.error) remove.forEach((p) => { ending[p] = r.current_period_end || g.endsAt || now; turnedOff.push(p); });
    } else {
      for (const p of remove) {
        const r = await stripeDelete('/subscription_items/' + items[p].itemId, { proration_behavior: 'none' });
        if (!r.error) { ending[p] = items[p].endsAt || now; turnedOff.push(p); }
      }
    }
  }

  // 3) Additions.
  //
  // A RETIRED module can never be added, only kept or dropped. P5 and P6 are
  // priced in Stripe but unbuilt, so they are gone from the panel: the only
  // people who can still hold one are those who bought it before it was pulled.
  // The filter is on ADDITIONS alone, deliberately. Their existing item is left
  // untouched above, so it keeps billing and rendering exactly as before, and
  // removal still works normally the moment they switch it off.
  const toAdd = [...desired].filter((p) => !items[p] && isSellable(p));

  // Clear the expiry for EVERYTHING they want on, not just the new additions.
  // Someone who switches a module off and then changes their mind before the
  // cycle ends is still being billed for it, so there is nothing to add: toAdd
  // is empty, and clearing only toAdd left the old expiry in place. The daily
  // sweep would then have switched off a module they were paying for.
  [...desired].forEach((p) => { delete ending[p]; });

  let url = null;
  if (toAdd.length) {
    const existingSub = subs.find((s) => LIVE_STATUSES.includes(s.status) && !s.cancel_at_period_end);
    if (account.stripeCustomerId && existingSub) {
      for (const p of toAdd) await stripePost('/subscription_items', { subscription: existingSub.id, price: MONTHLY[p], proration_behavior: 'none' });
    } else {
      // First purchase (or no live sub): ONE checkout bundling all adds.
      const tok = await panelToken(email);
      const back = '/panel?e=' + encodeURIComponent(email) + '&t=' + tok;
      const params = { mode: 'subscription', success_url: host + back + '&session_id={CHECKOUT_SESSION_ID}', cancel_url: host + back, allow_promotion_codes: 'true' };
      toAdd.forEach((p, i) => { params['line_items[' + i + '][price]'] = MONTHLY[p]; params['line_items[' + i + '][quantity]'] = 1; });
      if (account.stripeCustomerId) params.customer = account.stripeCustomerId; else params.customer_email = email;
      const sess = await stripePost('/checkout/sessions', params);
      if (sess.error || !sess.url) return { error: sess.error || 'checkout_failed' };
      url = sess.url;
    }
  }

  for (const p of Object.keys(ending)) if (!(ending[p] > now)) delete ending[p];
  await upsertAccount({ email: account.email, ending });

  // THE POINT OF THE WHOLE THING: push the new on/off state onto their live site,
  // so flipping a switch here changes what renders at /s/<slug>. No rebuild, no
  // deploy, no manual fulfilment. Wrapped because a site record may not exist yet
  // (a customer can have billing before we have built their page).
  //
  // PENDING CHECKOUT IS NOT PAID. `url` is set only when we had to send them to
  // Stripe, meaning those additions have not been paid for yet. This used to sync
  // them anyway, so booking and the AI assistant went live the instant someone
  // clicked Save, and abandoning the checkout left them switched on free forever.
  // They turn on when link() confirms the payment, not before.
  //
  // ONLY WHAT STRIPE IS ACTUALLY BILLING MAY RENDER. `desired` is just what the
  // browser asked for, so filtering it alone was not enough: any phase we
  // declined to add (a retired module, say) stayed in `desired` and got written
  // straight onto the live site, unpaid and unpayable. A phase renders only if
  // Stripe was already billing it when this request began (`held`) or we just
  // added it to a live subscription (`toAdd` with no checkout outstanding).
  //
  // THEY PAID FOR THE CYCLE, SO THEY KEEP THE CYCLE. Switching something off
  // used to strip it from the live site that same second, while the panel and
  // the billing both said it runs to the paid-through date. Flip Booking off on
  // the 2nd, paid to the 11th, and the booking form vanished on the 2nd: nine
  // days bought and not delivered. A turned-off module stays live until its
  // period actually ends, and cron-maintenance removes it the day after.
  try {
    const held = new Set(Object.keys(items));
    const pending = url ? new Set(toAdd) : new Set();
    const stillPaidFor = Object.keys(ending).filter((p) => ending[p] > now);
    const liveNow = [...new Set([
      ...[...desired].filter((p) => !turnedOff.includes(p) && !pending.has(p) && (held.has(p) || toAdd.includes(p))),
      ...stillPaidFor,
    ])];
    await syncModulesLoud(email, liveNow, 'customer-flipped-a-switch');
  } catch (err) { console.error('[switch] site sync', err); }

  // Tell the operator. Awaited so it actually runs before the serverless function
  // is frozen, but it can never throw and never blocks the customer's result.
  const who = account.name || account.site || email;
  if (turnedOff.length || toAdd.length) {
    const lines = [`Customer: ${who}`, `Email: ${email}`];
    if (toAdd.length) lines.push(url
      ? `STARTED CHECKOUT for: ${labelPhases(toAdd)} (not paid yet, they still have to finish on Stripe)`
      : `TURNED ON: ${labelPhases(toAdd)} (billing starts now)`);
    if (turnedOff.length) lines.push(`TURNED OFF: ${labelPhases(turnedOff)} (runs to the end of the paid cycle, then stops)`);
    await notifyOperator({
      subject: turnedOff.length && !toAdd.length
        ? `Switch OFF - ${who}`
        : `Switch change - ${who}`,
      heading: turnedOff.length && !toAdd.length ? 'A customer turned something off' : 'A customer changed their modules',
      lines,
      url: host + '/master', urlText: 'Open Master Panel',
    });
  }

  if (url) return { url };
  const st = await readState({ ...account, ending });
  return { ok: true, ...st };
}

async function link(account, sessionId, host) {
  if (!sessionId) return { error: 'no_session' };
  const sess = await stripeGet('/checkout/sessions/' + encodeURIComponent(sessionId));
  if (!sess) return { error: 'session_not_found' };
  const customer = typeof sess.customer === 'string' ? sess.customer : (sess.customer && sess.customer.id);
  if (!customer) return { error: 'no_customer' };
  const isNew = !account.stripeCustomerId || account.stripeCustomerId !== customer;
  if (isNew) {
    await upsertAccount({ email: account.email, stripeCustomerId: customer });
  }
  // Payment is confirmed, so NOW the modules they bought may render on their
  // site. applyChanges deliberately did not sync them, because at that point they
  // had only reached the checkout page.
  try {
    const subs = await liveSubs(customer);
    const live = Object.keys(itemsByPhase(subs));
    await syncModulesLoud(account.email, live, 'checkout-returned-paid');
  } catch (err) { console.error('[switch] link site sync', err); }

  // This is the moment money actually starts: checkout came back paid.
  if (isNew && sess.payment_status === 'paid') {
    const who = account.name || account.site || account.email;
    await notifyOperator({
      subject: `PAID - ${who} is now a paying customer`,
      heading: 'First payment went through',
      lines: [
        `Customer: ${who}`,
        `Email: ${account.email}`,
        sess.amount_total ? `Amount: $${(sess.amount_total / 100).toFixed(2)}` : '',
        'Their subscription is live. Check Master for what they switched on.',
      ].filter(Boolean),
      url: (host || '') + '/master', urlText: 'Open Master Panel',
    });
  }
  return { ok: true };
}
