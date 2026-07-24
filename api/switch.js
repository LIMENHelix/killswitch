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
import { MONTHLY, PRICE_TO_PHASE } from '../lib/prices.js';
import { stripeGet, stripePost, stripeDelete } from '../lib/stripe.js';

const LIVE_STATUSES = ['active', 'trialing', 'past_due'];

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};

  const email = String(body.e || '').trim().toLowerCase();
  const token = String(body.t || '');
  if (!verifyPanel(email, token)) { res.status(401).json({ error: 'unauthorized' }); return; }

  const account = await getAccount(email);
  if (!account) { res.status(404).json({ error: 'not_found' }); return; }

  const host = (req.headers && (req.headers.origin || (req.headers.host && ('https://' + req.headers.host)))) || 'https://killswitch.domains';
  const action = body.action || 'state';

  try {
    if (action === 'state') { res.status(200).json(await readState(account)); return; }
    if (action === 'apply') { res.status(200).json(await applyChanges(account, body.on, host, email)); return; }
    if (action === 'link')  { res.status(200).json(await link(account, body.session_id)); return; }
    res.status(400).json({ error: 'unknown_action' });
  } catch (err) {
    console.error('[switch]', action, err);
    res.status(500).json({ error: 'server_error' });
  }
}

async function liveSubs(customerId) {
  if (!customerId) return [];
  const r = await stripeGet('/subscriptions?customer=' + encodeURIComponent(customerId) + '&status=all&limit=100');
  const data = (r && Array.isArray(r.data)) ? r.data : [];
  return data.filter((s) => LIVE_STATUSES.includes(s.status));
}

function itemsByPhase(subs) {
  const map = {};
  for (const s of subs) {
    for (const it of (s.items && s.items.data) || []) {
      const phase = PRICE_TO_PHASE[it.price && it.price.id];
      if (!phase) continue;
      map[phase] = { subId: s.id, itemId: it.id, endsAt: s.current_period_end || null, cancelAtEnd: !!s.cancel_at_period_end };
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
  return { site: account.site || '', name: account.name || '', linked: !!account.stripeCustomerId, modules };
}

async function applyChanges(account, on, host, email) {
  const desired = new Set((Array.isArray(on) ? on : []).filter((p) => MONTHLY[p]));
  let subs = await liveSubs(account.stripeCustomerId);
  let items = itemsByPhase(subs);
  const ending = { ...(account.ending || {}) };
  const now = Math.floor(Date.now() / 1000);

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
      if (!r.error) remove.forEach((p) => { ending[p] = r.current_period_end || g.endsAt || now; });
    } else {
      for (const p of remove) {
        const r = await stripeDelete('/subscription_items/' + items[p].itemId, { proration_behavior: 'none' });
        if (!r.error) ending[p] = items[p].endsAt || now;
      }
    }
  }

  // 3) Additions.
  const toAdd = [...desired].filter((p) => !items[p]);
  toAdd.forEach((p) => { delete ending[p]; });

  let url = null;
  if (toAdd.length) {
    const existingSub = subs.find((s) => LIVE_STATUSES.includes(s.status) && !s.cancel_at_period_end);
    if (account.stripeCustomerId && existingSub) {
      for (const p of toAdd) await stripePost('/subscription_items', { subscription: existingSub.id, price: MONTHLY[p], proration_behavior: 'none' });
    } else {
      // First purchase (or no live sub): ONE checkout bundling all adds.
      const tok = panelToken(email);
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

  if (url) return { url };
  const st = await readState({ ...account, ending });
  return { ok: true, ...st };
}

async function link(account, sessionId) {
  if (!sessionId) return { error: 'no_session' };
  const sess = await stripeGet('/checkout/sessions/' + encodeURIComponent(sessionId));
  if (!sess) return { error: 'session_not_found' };
  const customer = typeof sess.customer === 'string' ? sess.customer : (sess.customer && sess.customer.id);
  if (!customer) return { error: 'no_customer' };
  if (!account.stripeCustomerId || account.stripeCustomerId !== customer) {
    await upsertAccount({ email: account.email, stripeCustomerId: customer });
  }
  return { ok: true };
}
