// Public-link integrations used by the customer site.
//
// These are destinations, not provider credentials. Killswitch never needs a
// customer's Google, calendar, or payment password to send a visitor to their
// public profile, booking page, or hosted checkout. Keeping that distinction
// explicit avoids building a fake OAuth flow or storing secrets we do not use.

export const INTEGRATIONS = {
  googleBusinessProfile: {
    phase: 'P1',
    label: 'Google Business Profile',
    note: 'The public Google Maps or Business Profile link customers can open.',
    placeholder: 'https://maps.app.goo.gl/...',
  },
  bookingUrl: {
    phase: 'P3',
    label: 'Booking calendar',
    note: 'Your public Calendly, Square, Cal.com, Booksy, or other scheduling page.',
    placeholder: 'https://calendly.com/your-business/...',
  },
  payUrl: {
    phase: 'P7',
    label: 'Secure payment page',
    note: 'A hosted checkout from Stripe, Square, PayPal, Venmo, or Clover.',
    placeholder: 'https://buy.stripe.com/...',
  },
};

const GOOGLE_HOSTS = ['google.com', 'maps.app.goo.gl', 'goo.gl', 'g.page'];
const PAYMENT_HOSTS = [
  'stripe.com', 'square.link', 'square.site', 'paypal.com', 'paypal.me',
  'venmo.com', 'clover.com', 'clover.link',
];

function hostMatches(hostname, roots) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return roots.some((root) => host === root || host.endsWith('.' + root));
}

function isPublicHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.local')) return false;
  if (/^(?:127\.|10\.|192\.168\.|169\.254\.)/.test(host)) return false;
  const m = host.match(/^172\.(\d{1,3})\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return false;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return false;
  return true;
}

export function validateIntegration(field, raw) {
  if (!Object.prototype.hasOwnProperty.call(INTEGRATIONS, field)) return { error: 'unknown_integration' };
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return { value: '', provider: '' };
  if (value.length > 500) return { error: 'link_too_long' };

  let url;
  try { url = new URL(value); } catch { return { error: 'valid_https_link_required' }; }
  if (url.protocol !== 'https:' || url.username || url.password || !isPublicHost(url.hostname)) {
    return { error: 'valid_https_link_required' };
  }

  if (field === 'googleBusinessProfile' && !hostMatches(url.hostname, GOOGLE_HOSTS)) {
    return { error: 'google_profile_link_required' };
  }
  if (field === 'payUrl' && !hostMatches(url.hostname, PAYMENT_HOSTS)) {
    return { error: 'recognized_payment_provider_required' };
  }

  // Fragments are browser-only decoration and create duplicate lifecycle events
  // for the same destination. Keep the public URL otherwise unchanged.
  url.hash = '';
  return { value: url.toString(), provider: url.hostname.toLowerCase() };
}

export function integrationCatalogue(site = {}) {
  const phases = new Set(Array.isArray(site.modules) ? site.modules : []);
  return Object.entries(INTEGRATIONS).map(([field, def]) => ({
    field,
    ...def,
    active: phases.has(def.phase),
    connected: !!site[field],
    value: site[field] || '',
  }));
}
