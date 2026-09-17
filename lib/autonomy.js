// The zero-dollar product is a real, immediately usable website. This helper
// turns a customer-submitted business name into the shared-template site record
// before onboarding sends a welcome email.
import { existingSlugs, getSite, siteForEmail, upsertSite } from './sites.js';
import { uniqueSlug } from './draft-site.js';
import { seedSite, seedMissing } from './site-seed.js';

/**
 * @param {string} [trade] the trade key, when a caller knows it. The /start
 *   intake form collects it ("What you do"); the Stripe path does not. Without
 *   it a new site gets a factual about line and NO service list, because
 *   guessing a menu from a business name is the invention this codebase
 *   refuses.
 * @param {string} [city] free-text town/area from the intake form. Used in the
 *   factual about/tagline lines of a NEW record.
 * @param {string[]} [services] customer-typed service list [{name, desc}].
 *   The ONLY source of a service list on a new record: what the owner said.
 *   There is no generated trade menu any more — category alone is not evidence
 *   of what a shop sells. Existing records never get content touched.
 * @param {string} [about] customer-typed about text. Same rule: wins over the
 *   generated factual sentence on a NEW record only.
 *
 * EXISTING RECORDS: scalar facts (phone, trade, city, state, street, zip,
 * email_public) fill a field only when it is empty. Content fields (about,
 * services, hours, tagline) are never written to a record that already exists,
 * because anything already there is either the customer's own words or copy
 * a human approved, and both beat a signup form.
 */
export async function ensureCustomerSite({ email, business, phone = '', trade = '', city = '', state = '', street = '', zip = '', emailPublic = '', services = null, hours = null, about = '', source = 'customer-inbound' }) {
  const e = String(email || '').trim().toLowerCase();
  const name = String(business || '').trim();
  if (!e || !name) throw new Error('email and business required');

  // Scalar facts that are safe to fill when empty. Content is deliberately
  // absent: an empty about on an existing record stays empty rather than being
  // replaced by generated text.
  const scalarFacts = {
    phone: String(phone || '').trim(),
    trade: String(trade || '').trim(),
    city: String(city || '').trim(),
    state: String(state || '').trim(),
    street: String(street || '').trim(),
    zip: String(zip || '').trim(),
    email_public: String(emailPublic || '').trim(),
  };

  const linked = await siteForEmail(e);
  if (linked) {
    const site = await upsertSite({
      slug: linked.slug,
      ...Object.fromEntries(Object.entries(scalarFacts).map(([k, v]) => [k, linked[k] || v])),
      // THIN EXISTING RECORDS GET COMPLETED, never rewritten. seedMissing fills
      // only empty content fields (tagline/about/services/theme/layout), so a
      // record written before the seeder existed becomes a full page the next
      // time its owner signs up or checks out, and nothing they typed is lost.
      ...seedMissing(linked),
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
      ...Object.fromEntries(Object.entries(scalarFacts).map(([k, v]) => [k, exact[k] || v])),
      ...seedMissing(exact),
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
  const seed = seedSite({ business: name, trade, city, state });
  const ownServices = Array.isArray(services) && services.length ? services : null;
  const ownHours = Array.isArray(hours) && hours.length ? hours : null;
  const ownAbout = String(about || '').trim();

  const site = await upsertSite({
    ...seed,
    slug,
    email: e,
    business: name,
    ...scalarFacts,
    // WHAT THE CUSTOMER SAID IS THE ONLY SERVICE LIST THERE IS. An own list,
    // own hours or own about lands on a brand new record; absent one, the
    // factual fallback (about/tagline from name, trade, town) stands and the
    // services section simply does not render. Category alone never invents one.
    services: ownServices || [],
    hours: ownHours || [],
    about: ownAbout || seed.about,
    modules: ['P0'],
    published: true,
    claimed: true,
    source,
  });
  return { site, created: true };
}
