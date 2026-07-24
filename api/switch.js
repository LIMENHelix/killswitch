// Phase 2 billing engine for the customer panel. Each paid switch is its own
// Stripe subscription, so "off" is cancel_at_period_end (runs to the date, then
// stops, no surprise charge) and Stripe itself is the source of truth.
//
// POST /api/switch  body: { action, e, t, ... }   (auth = passwordless portal token)
//   'state'  -> { site, name, modules:{ P1:{state,endsAt}, ... } }   live from Stripe
//   'on'     -> { url } (go to Stripe checkout) OR { ok, reactivated|already }
//   'off'    -> { ok, endsAt }  (cancel_at_period_end on that switch's sub)
//   'link'   -> { ok }          (attach the Stripe customer after checkout returns)
import { getAccount, upsertAccount } from '../lib/store.js';
import { verifyPanel, panelToken } from '../lib/panel-auth.js';
import { MONTHLY, PRICE_TO_PHASE } from '../lib/prices.js';
import { stripeGet, stripePost } from '../lib/stripe.js';

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
    if (action === 'on')    { res.status(200).json(await turnOn(account, body.phase, host, email)); return; }
    if (action === 'off')   { res.status(200).json(await turnOff(account, body.phase)); return; }
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

// price -> { subId, state, endsAt } for this customer's live subscriptions
function indexByPhase(subs) {
  const map = {};
  for (const s of subs) {
    const items = (s.items && s.items.data) || [];
    for (const it of items) {
      const priceId = it.price && it.price.id;
      const phase = PRICE_TO_PHASE[priceId];
      if (!phase) continue;
      map[phase] = {
        subId: s.id,
        state: s.cancel_at_period_end ? 'ending' : 'active',
        endsAt: s.current_period_end || null,
      };
    }
  }
  return map;
}

async function readState(account) {
  const subs = await liveSubs(account.stripeCustomerId);
  const idx = indexByPhase(subs);
  const modules = {};
  for (const phase of Object.keys(idx)) modules[phase] = { state: idx[phase].state, endsAt: idx[phase].endsAt };
  return { site: account.site || '', name: account.name || '', linked: !!account.stripeCustomerId, modules };
}

async function turnOn(account, phase, host, email) {
  const priceId = MONTHLY[phase];
  if (!priceId) return { error: 'unknown_switch' };

  // Already have a live sub for this price? Reactivate it instead of a new charge.
  const subs = await liveSubs(account.stripeCustomerId);
  const existing = subs.find((s) => (s.items && s.items.data || []).some((it) => it.price && it.price.id === priceId));
  if (existing) {
    if (existing.cancel_at_period_end) {
      const upd = await stripePost('/subscriptions/' + existing.id, { cancel_at_period_end: false });
      if (upd.error) return { error: upd.error };
      return { ok: true, reactivated: true };
    }
    return { ok: true, already: true };
  }

  // No sub yet: Stripe Checkout (collects/reuses card). Reuse customer if known.
  const tok = panelToken(email);
  const back = '/panel?e=' + encodeURIComponent(email) + '&t=' + tok;
  const params = {
    mode: 'subscription',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': 1,
    success_url: host + back + '&session_id={CHECKOUT_SESSION_ID}',
    cancel_url: host + back,
    allow_promotion_codes: 'true',
  };
  if (account.stripeCustomerId) params.customer = account.stripeCustomerId;
  else params.customer_email = email;

  const sess = await stripePost('/checkout/sessions', params);
  if (sess.error || !sess.url) return { error: sess.error || 'checkout_failed' };
  return { url: sess.url };
}

async function turnOff(account, phase) {
  const priceId = MONTHLY[phase];
  if (!priceId) return { error: 'unknown_switch' };
  const subs = await liveSubs(account.stripeCustomerId);
  const sub = subs.find((s) => (s.items && s.items.data || []).some((it) => it.price && it.price.id === priceId));
  if (!sub) return { error: 'not_active' };
  if (sub.cancel_at_period_end) return { ok: true, endsAt: sub.current_period_end };
  const upd = await stripePost('/subscriptions/' + sub.id, { cancel_at_period_end: true });
  if (upd.error) return { error: upd.error };
  return { ok: true, endsAt: upd.current_period_end || sub.current_period_end };
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
