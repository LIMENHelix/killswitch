// Customer SITE records: the data half of the one-template system.
//
// The old way was one hand-built HTML file per customer, which is why nothing
// scaled: every customer was a build, and every module they bought was a manual
// fulfilment. Here a site is DATA, and the same template renders all of them.
//
// modules[] is the on/off state. api/switch.js writes it whenever a customer
// flips something, so rendering never has to call Stripe (fast, free, and it
// still works if Stripe is briefly down). Stripe stays the source of truth for
// BILLING; this is the source of truth for WHAT RENDERS.

const URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SITES_KEY = 'ks:sites';

async function cmd(args) {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('kv ' + r.status + ': ' + JSON.stringify(j).slice(0, 160));
  return j.result;
}

export function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 60);
}

// Everything a site can hold. Missing fields simply do not render, so a
// half-filled record still produces a clean page rather than a broken one.
export const SITE_DEFAULT = {
  slug: '', email: '', business: '', trade: '', tagline: '',
  phone: '', email_public: '',
  street: '', city: '', state: '', zip: '',
  hours: [],            // [{ d:'Mon to Fri', h:'8am to 6pm' }]
  services: [],         // [{ name, desc }]
  about: '',
  accent: '#12703C',
  bookingUrl: '',       // P3
  payUrl: '',           // P7
  posts: [],            // [{ title, body, date }]  P2
  modules: ['P0'],      // what is switched ON
  published: false,
};

export async function getSites() {
  const v = await cmd(['GET', SITES_KEY]);
  if (!v) return {};
  try { return JSON.parse(v) || {}; } catch { return {}; }
}

export async function getSite(slug) {
  const m = await getSites();
  const s = m[slugify(slug)];
  return s ? { ...SITE_DEFAULT, ...s } : null;
}

export async function upsertSite(site) {
  const slug = slugify(site && (site.slug || site.business));
  if (!slug) throw new Error('slug or business required');
  const m = await getSites();
  m[slug] = { ...SITE_DEFAULT, ...(m[slug] || {}), ...site, slug };
  await cmd(['SET', SITES_KEY, JSON.stringify(m)]);
  return m[slug];
}

/** Find the site belonging to a customer email, so switch.js can sync modules. */
export async function siteForEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  const m = await getSites();
  const hit = Object.values(m).find((s) => String(s.email || '').toLowerCase() === e);
  return hit ? { ...SITE_DEFAULT, ...hit } : null;
}

/** Called by api/switch.js after a change so the live site matches what they pay for. */
export async function syncModules(email, modules) {
  const s = await siteForEmail(email);
  if (!s) return null;
  return upsertSite({ slug: s.slug, modules: Array.from(new Set(['P0', ...(modules || [])])) });
}

// Which modules actually change the WEBSITE. The rest are real products but they
// are back-office (CRM, automation, the sales agent), so they render nothing and
// pretending otherwise would be a lie on the page.
export const SITE_MODULES = {
  P1: 'Search listing',
  P2: 'Updates & posts',
  P3: 'Online booking',
  P7: 'Pay online',
  P8: 'Analytics',
  P9: '24/7 AI assistant',
};
export const BACKOFFICE_MODULES = { P4: 'Hosting', P5: 'CRM', P6: 'Automation', P10: 'AI sales agent', P11: 'Care plan' };

export function has(site, mod) {
  return Array.isArray(site.modules) && site.modules.includes(mod);
}
