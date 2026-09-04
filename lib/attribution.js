// Normalize the small, first-party campaign envelope accepted by public forms.
// The browser captures only campaign parameters and the referring hostname; it
// does not create a user identifier or accept arbitrary nested marketing data.

const FIELDS = {
  source: 80,
  medium: 80,
  campaign: 120,
  content: 120,
  term: 120,
  landingPage: 180,
  referrerHost: 120,
  gclid: 180,
  msclkid: 180,
  fbclid: 180,
};

export function normalizeAttribution(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, max] of Object.entries(FIELDS)) {
    if (typeof value[key] !== 'string') continue;
    const clean = value[key].trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
    if (clean) out[key] = clean;
  }
  return out;
}
