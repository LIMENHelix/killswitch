// Cloudflare Turnstile for the two public signup forms.
//
// The hidden field and the minimum fill time in api/inbound.js raise the cost of
// a scripted signup; they do not stop one, because a bot can send an empty field
// and a plausible elapsedMs. Turnstile is the part a script has to actually
// solve. It is free, sets no cookies on the visitor, and is invisible for most
// people, which is the reason it is here rather than a picture CAPTCHA on a page
// whose whole promise is "no friction".
//
// WHY THIS DEGRADES OPEN, DELIBERATELY
// With no secret configured the check is skipped, the form renders no widget,
// and signup keeps working. That is not a bug: it means deploying this code
// before the Cloudflare secret exists does not take the funnel down, and local
// and CI runs do not need credentials. `preflight` reports the missing key, so
// the open state is visible in the owner's own config report rather than silent.
//
// WHY IT FAILS CLOSED ON ERROR
// Once a secret IS configured, a verification call that errors rejects the
// signup. A Cloudflare outage is rare and brief; a bot wave through an
// unverified endpoint is the exact thing this exists to stop, and an attacker
// who can make siteverify fail could otherwise bypass the check at will.
const ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function secret() {
  return String(process.env.TURNSTILE_SECRET_KEY || '').trim();
}

/** True when a secret exists, so callers and the config report can say so. */
export function turnstileConfigured() {
  return !!secret();
}

/**
 * Check one Turnstile token.
 * @returns {Promise<{ok:boolean, skipped?:boolean, error?:string}>}
 */
export async function verifyTurnstile(token, ip) {
  const s = secret();
  if (!s) return { ok: true, skipped: true };

  const t = String(token || '').trim();
  if (!t) return { ok: false, error: 'verification_required' };

  try {
    const form = new URLSearchParams({ secret: s, response: t.slice(0, 2048) });
    if (ip && ip !== 'unknown') form.set('remoteip', ip);
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const d = await r.json().catch(() => ({}));
    if (d && d.success) return { ok: true };
    return { ok: false, error: 'verification_failed' };
  } catch (e) {
    console.error('[turnstile] verify', e);
    return { ok: false, error: 'verification_unavailable' };
  }
}
