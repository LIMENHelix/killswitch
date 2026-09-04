// Who is entitled to what, and the one place that repairs a broken payment link.
//
// Two jobs, both of which were missing entirely.
//
// 1. ENTITLEMENT. The business model is: the free site is a GENERIC TEMPLATE the
//    customer keeps, and anything custom is labour we charge for. Nothing in the
//    code enforced the second half, so every free customer could request
//    unlimited hand edits through the panel forever. Stripe is the source of
//    truth for billing, so the answer is read from live subscriptions.
//
// 2. SELF-HEALING THE STRIPE LINK. An account learns its Stripe customer id only
//    when the browser returns to success_url after checkout (api/switch.js link).
//    Close the tab on Stripe's receipt page and the payment is real but the
//    account never hears about it: /master shows them free, their own panel shows
//    every module OFF, and no PAID notification fires. There is no webhook to
//    catch it. So whenever we need the id and do not have one, look it up by
//    email and attach it. An account that is already linked costs zero extra
//    Stripe calls.
import { upsertAccount } from './store.js';
import { stripeGet } from './stripe.js';
import { PRICE_TO_PHASE } from './prices.js';
import { notifyOperator } from './notify.js';

// past_due counts as live: they are still a customer, the card just failed.
const LIVE_STATUSES = ['active', 'trialing', 'past_due'];

/** Live subscriptions for a Stripe customer id. [] when unknown or unconfigured. */
export async function liveSubs(customerId) {
  if (!customerId) return [];
  const r = await stripeGet('/subscriptions?customer=' + encodeURIComponent(customerId) + '&status=all&limit=100');
  const data = (r && Array.isArray(r.data)) ? r.data : [];
  return data.filter((s) => LIVE_STATUSES.includes(s.status));
}

/**
 * Find the Stripe customer for an email address.
 * Prefers one that actually has a live subscription, because a customer object
 * can be created by an abandoned checkout and we want the one that is paying.
 * @returns {Promise<{id:string, paying:boolean}|null>}
 */
export async function findStripeCustomer(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  const r = await stripeGet('/customers?limit=10&email=' + encodeURIComponent(e));
  const list = (r && Array.isArray(r.data)) ? r.data : [];
  if (!list.length) return null;
  if (list.length === 1) {
    const subs = await liveSubs(list[0].id);
    return { id: list[0].id, paying: subs.length > 0 };
  }
  // Several customer objects for one address. Take the first that is paying.
  for (const c of list.slice(0, 4)) {
    const subs = await liveSubs(c.id);
    if (subs.length) return { id: c.id, paying: true };
  }
  return { id: list[0].id, paying: false };
}

/**
 * Guarantee account.stripeCustomerId is populated if Stripe knows this email.
 * Notifies the operator when it repairs a link that was carrying real money,
 * because that payment was invisible until this moment.
 * @returns {Promise<object>} the account, linked where possible
 */
export async function ensureLinked(account, host) {
  if (!account || account.stripeCustomerId) return account;
  let found = null;
  try { found = await findStripeCustomer(account.email); }
  catch (e) { console.error('[entitle] lookup', e); return account; }
  if (!found) return account;

  const updated = await upsertAccount({ email: account.email, stripeCustomerId: found.id });

  if (found.paying) {
    const who = account.name || account.site || account.email;
    await notifyOperator({
      subject: `PAID - ${who} is now a paying customer`,
      heading: 'A payment was found that had never been recorded',
      lines: [
        `Customer: ${who}`,
        `Email: ${account.email}`,
        'They paid on Stripe but never landed back on our site, so the account was still showing as free.',
        'It has now been linked automatically. Nothing is owed and nothing was double charged.',
      ],
      url: (host || 'https://killswitchwebsites.com') + '/master',
      urlText: 'Open Master Panel',
    });
  }
  return updated;
}

/**
 * The set of module phases this customer is actually paying for.
 * A module winding down (cancel_at_period_end) still counts: they paid for the
 * cycle, so they keep it until it ends.
 * @returns {Promise<{account:object, phases:Set<string>}>}
 */
export async function entitlements(account, host) {
  const acct = await ensureLinked(account, host);
  const phases = effectiveOwned(acct);
  const subs = await liveSubs(acct && acct.stripeCustomerId);
  for (const s of subs) {
    for (const it of (s.items && s.items.data) || []) {
      const p = PRICE_TO_PHASE[it.price && it.price.id];
      if (p) phases.add(p);
    }
  }
  return { account: acct, phases };
}

/** Purchased outright and currently switched on. Ownership is never deleted. */
export function effectiveOwned(account) {
  const disabled = new Set((account && account.ownedDisabled) || []);
  return new Set(((account && account.owned) || []).filter((phase) => !disabled.has(phase)));
}

// Which add-ons buy "a person makes the change for you". The free site is a
// generic template and stays free forever; hand edits are the labour, and the
// labour is what we sell. Care Plan is the change-request product; Hosting &
// Maintenance includes small edits, so it counts too.
export const CHANGE_PHASES = ['P11', 'P4'];

export function canRequestChanges(phases) {
  return CHANGE_PHASES.some((p) => phases.has(p));
}
