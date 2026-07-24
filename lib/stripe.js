// Minimal Stripe REST helpers (no SDK), matching the pattern in api/checkout.js.
// Uses STRIPE_SECRET_KEY from the Vercel project.
function key() { return process.env.STRIPE_SECRET_KEY; }

export function configured() { return !!key(); }

export async function stripeGet(path) {
  const k = key();
  if (!k) return null;
  const r = await fetch('https://api.stripe.com/v1' + path, {
    headers: { Authorization: 'Bearer ' + k },
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) { console.error('[stripe GET]', path, r.status, j && j.error && j.error.message); return null; }
  return j;
}

export async function stripeDelete(path, params) {
  const k = key();
  if (!k) return { error: 'not_configured' };
  const qs = new URLSearchParams();
  for (const [name, val] of Object.entries(params || {})) {
    if (val !== undefined && val !== null) qs.append(name, String(val));
  }
  const url = 'https://api.stripe.com/v1' + path + (qs.toString() ? ('?' + qs.toString()) : '');
  const r = await fetch(url, { method: 'DELETE', headers: { Authorization: 'Bearer ' + k } });
  const j = await r.json().catch(() => null);
  if (!r.ok) { console.error('[stripe DELETE]', path, r.status, j && j.error && j.error.message); return { error: (j && j.error && j.error.message) || ('http ' + r.status) }; }
  return j;
}

export async function stripePost(path, params) {
  const k = key();
  if (!k) return { error: 'not_configured' };
  const body = new URLSearchParams();
  for (const [name, val] of Object.entries(params || {})) {
    if (val !== undefined && val !== null) body.append(name, String(val));
  }
  const r = await fetch('https://api.stripe.com/v1' + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + k, 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) { console.error('[stripe POST]', path, r.status, j && j.error && j.error.message); return { error: (j && j.error && j.error.message) || ('http ' + r.status) }; }
  return j;
}
