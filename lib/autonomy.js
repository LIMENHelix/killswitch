// The zero-dollar product is a real, immediately usable website. This helper
// turns a customer-submitted business name into the shared-template site record
// before onboarding sends a welcome email.
import { existingSlugs, getSite, siteForEmail, upsertSite } from './sites.js';
import { uniqueSlug } from './draft-site.js';
import { seedSite } from './site-seed.js';

/**
 * @param {string} [trade] the trade key, when a caller knows it. Neither caller
 *   does today: the homepage form collects business, phone and email, and
 *   Stripe gives a customer name. Without it a new site gets a factual about
 *   line and NO service list, because guessing a menu from a business name is
 *   the invention this codebase refuses. Adding a trade field to the homepage
 *   form is what would close that, and is not this change.
 */
export async function ensureCustomerSite({ email, business, phone = '', trade = '', source = 'customer-inbound' }) {
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

  // THE SECOND FRONT DOOR. draftFromLead() seeds the cold-outreach path, and
  // this is the paid and homepage path, so without this a customer who pays
  // gets a barer site than a prospect who never asked for one. That is how
  // old-school-iron ended up as four blocks.
  //
  // NEW RECORDS ONLY. The two branches above return before reaching this, so a
  // linked site and a claimed prospect draft are both untouched. Spread first,
  // so every explicit field below still wins over anything generated.
  const seed = seedSite({ business: name, trade, city: '', state: '' });

  const site = await upsertSite({
    ...seed,
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
