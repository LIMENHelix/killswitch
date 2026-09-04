// The zero-dollar product is a real, immediately usable website. This helper
// turns a customer-submitted business name into the shared-template site record
// before onboarding sends a welcome email.
import { existingSlugs, getSite, siteForEmail, upsertSite } from './sites.js';
import { uniqueSlug } from './draft-site.js';

export async function ensureCustomerSite({ email, business, phone = '', source = 'customer-inbound' }) {
  const e = String(email || '').trim().toLowerCase();
  const name = String(business || '').trim();
  if (!e || !name) throw new Error('email and business required');

  const linked = await siteForEmail(e);
  if (linked) {
    const site = await upsertSite({
      slug: linked.slug,
      phone: linked.phone || String(phone || '').trim(),
      published: true,
      claimed: true,
    });
    return { site, created: false };
  }

  const taken = await existingSlugs();
  const preferred = uniqueSlug(name, '', new Set());
  const exact = preferred ? await getSite(preferred) : null;

  // A prospect draft with no owner is safe to claim. A site owned by somebody
  // else is never touched; the new customer gets a collision-safe slug.
  if (exact && (!exact.email || String(exact.email).trim().toLowerCase() === e)) {
    const site = await upsertSite({
      slug: exact.slug,
      email: e,
      business: exact.business || name,
      phone: exact.phone || String(phone || '').trim(),
      modules: Array.from(new Set(['P0', ...(exact.modules || [])])),
      published: true,
      claimed: true,
      source: exact.source || source,
    });
    return { site, created: false };
  }

  const slug = uniqueSlug(name, '', taken);
  if (!slug) throw new Error('could not allocate site slug');
  const site = await upsertSite({
    slug,
    email: e,
    business: name,
    phone: String(phone || '').trim(),
    modules: ['P0'],
    published: true,
    claimed: true,
    source,
  });
  return { site, created: true };
}
