// Links that carry panel tokens or Stripe return state must never be built from
// request headers. Origin and Host are caller-controlled on public endpoints.
const DEFAULT_ORIGIN = 'https://killswitchwebsites.com';

export function publicOrigin() {
  const raw = String(process.env.KS_PUBLIC_ORIGIN || DEFAULT_ORIGIN).trim();
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      return DEFAULT_ORIGIN;
    }
    return url.origin;
  } catch {
    return DEFAULT_ORIGIN;
  }
}
