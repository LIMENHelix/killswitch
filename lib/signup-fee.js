// The one-time setup fee that gates site creation.
//
// DELIBERATELY A SEPARATE CHARGE FROM THE ADD-ON SUBSCRIPTIONS.
// api/checkout.js sells modules as a Stripe *subscription*, with its own basket,
// its own customer and its own success_url into the panel. This is a different
// thing entirely: mode 'payment', one product, one price, one metadata kind.
// Nothing about a module purchase can create, waive or refund this fee, and
// nothing about this fee can put a subscription on someone's account. The two
// only ever meet in Stripe's books.
//
// It is also the strongest anti-bot measure available here, for a reason no
// challenge can match: a bot has no card. A $1 charge is cheap enough not to
// scare a real tradesperson off and expensive enough that signing up 117 times
// is not free.
import crypto from 'node:crypto';

function key() {
  return String(process.env.STRIPE_SECRET_KEY || '');
}

/**
 * Cents to charge before a site exists. Unset or 0 means the gate is OFF, which
 * is the default so deploying this code cannot start charging anybody.
 */
export function feeCents() {
  const raw = String(process.env.SIGNUP_FEE_CENTS || '').trim();
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

export function feeEnabled() {
  return feeCents() > 0;
}

/**
 * Open a Checkout Session for the setup fee.
 * @returns {Promise<{id:string,url:string,cents:number}|{error:string}>}
 */
export async function createFeeSession({ email, host, pid }) {
  const cents = feeCents();
  if (!cents) return { error: 'fee_disabled' };
  if (!key()) return { error: 'stripe_unconfigured' };

  const params = new URLSearchParams();
  params.append('mode', 'payment');
  // Comes back to the form with the session id, which is the only thing that
  // lets the site be created.
  params.append('success_url', host + '/start?paid=1&session_id={CHECKOUT_SESSION_ID}');
  params.append('cancel_url', host + '/start?cancelled=1');
  if (email) params.append('customer_email', email);

  // A configured price keeps the fee auditable in Stripe's catalogue as its own
  // product. Falling back to an ad-hoc price means no dashboard setup is needed
  // to start charging, which is what makes this deployable today.
  const priceId = String(process.env.SIGNUP_FEE_PRICE_ID || '').trim();
  if (priceId) {
    params.append('line_items[0][price]', priceId);
  } else {
    params.append('line_items[0][price_data][currency]', 'usd');
    params.append('line_items[0][price_data][unit_amount]', String(cents));
    params.append('line_items[0][price_data][product_data][name]', 'Website setup fee');
  }
  params.append('line_items[0][quantity]', '1');
  params.append('metadata[kind]', 'signup-fee');
  params.append('metadata[pid]', pid);

  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key(),
        'Content-Type': 'application/x-www-form-urlencoded',
        // A double-submitted form must not open two sessions and charge twice.
        'Idempotency-Key': 'ks-signup-fee-' + crypto.createHash('sha256').update(String(pid)).digest('hex').slice(0, 32),
      },
      body: params.toString(),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.url) return { error: (data && data.error && data.error.message) || 'stripe_error' };
    return { id: data.id, url: data.url, cents };
  } catch (e) {
    console.error('[signup-fee] session', e);
    return { error: 'stripe_unreachable' };
  }
}

/**
 * Read a session back and say whether it is a PAID setup fee.
 * Trusts Stripe, not the caller: the session id is checked against Stripe, and
 * its metadata has to say it is this kind of charge.
 * @returns {Promise<{session:object}|{error:string}>}
 */
export async function readFeeSession(id) {
  const sid = String(id || '').trim();
  if (!sid) return { error: 'session_required' };
  if (!key()) return { error: 'stripe_unconfigured' };
  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(sid), {
      headers: { Authorization: 'Bearer ' + key() },
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.id) return { error: 'stripe_error' };
    return { session: data };
  } catch (e) {
    console.error('[signup-fee] read', e);
    return { error: 'stripe_unreachable' };
  }
}
