// Turn a lead into a DRAFT website record.
//
// A draft is unpublished, which api/site.js serves as a hard 404, so nothing here
// is ever public until a person flips it. That is what makes bulk generation safe:
// the business has agreed to nothing yet, and an unpublished draft is invisible to
// them, to Google, and to anyone guessing URLs.
//
// WHAT GOES IN, AND WHAT DELIBERATELY DOES NOT.
// Only facts we actually hold: the business name, trade, phone and address off the
// lead record. No "family run since 1998", no years in business, no review counts,
// no owner name, no hours. We do not know any of that, and a website that invents
// it is worse than no website: the first thing the owner reads on the delivery call
// would be something untrue about their own shop.
//
// The one thing generated rather than known is the SERVICE LIST, which is the
// standard menu for that trade and exists so the page is not empty. It is the
// starting point for the delivery conversation ("that's a guess at your services,
// tell me what's wrong"), not a claim. For the three medical trades it is left
// empty on purpose: a wrong service list for a healthcare provider is a different
// class of mistake to a wrong one for a barber.

import { slugify } from './sites.js';
import { tradeEntry, tradeLabel, seedSite } from './site-seed.js';

// The trade table moved to lib/site-seed.js so the signup path and the bulk
// draft path cannot drift apart on what a plumber does. tradeLabel is still
// exported from here because that is where callers have always found it.
export { tradeLabel };


/**
 * Build a unique slug, preferring the plain business name and falling back to
 * name-city then name-city-2. Two shops really are called the same thing.
 * @param {Set<string>} taken mutated as slugs are claimed
 */
export function uniqueSlug(business, city, taken) {
  const base = slugify(business);
  if (!base) return '';
  if (!taken.has(base)) { taken.add(base); return base; }
  const withCity = slugify(business + ' ' + (city || ''));
  if (withCity && withCity !== base && !taken.has(withCity)) { taken.add(withCity); return withCity; }
  for (let n = 2; n < 200; n++) {
    const s = (withCity || base) + '-' + n;
    if (!taken.has(s)) { taken.add(s); return s; }
  }
  return '';
}

/**
 * @param {object} lead  a row from the lead list
 * @param {Set<string>} taken slugs already in use
 * @returns {object|null} a draft site record, or null if there is nothing to build from
 */
export function draftFromLead(lead, taken) {
  const business = String(lead.name || '').trim();
  if (!business) return null;
  const slug = uniqueSlug(business, lead.city, taken);
  if (!slug) return null;

  const rawTrade = String(lead.trade || '').toLowerCase();
  const cfg = tradeEntry(rawTrade);
  const city = String(lead.city || '').trim();
  const state = String(lead.state || '').trim();

  // ONE source for every generated field, shared with the signup path.
  //
  // Looked up by the RAW trade key, never by the label we store on the record.
  // The label for `hvac` is "Heating & cooling", which is not a key, so seeding
  // from the stored label would silently return nothing for half the trades and
  // the page would go out empty for exactly the trades that buy.
  const seed = seedSite({ business, trade: rawTrade, city, state });

  return {
    slug,
    business,
    trade: cfg ? cfg.label : (lead.trade || ''),
    // Factual: what they do and where. Nothing claimed beyond the lead record.
    tagline: seed.tagline,
    phone: String(lead.phone || '').trim(),
    street: String(lead.street || '').trim(),
    city,
    state,
    zip: String(lead.zip || '').trim(),
    email: '',            // no lead in this list has one, so there is nobody to attach
    email_public: '',
    // WHO SAID IT DECIDES WHERE IT GOES.
    // Opening hours on Google are published by the business itself, so they are
    // theirs and they go live. An editorial summary is Google's description OF
    // them, which is a different thing, so it waits in `proposed` for a human
    // exactly like anything else we did not hear from the owner.
    //
    // `about` is now a seeded sentence rather than blank, and that does NOT
    // relax the rule above. It is assembled only from the name, trade and town
    // already on this record, which is the same class of fact as `tagline`
    // directly above and has been going live since the first draft shipped.
    // Google's words still go nowhere near it; they stay in `proposed`.
    about: seed.about,
    hours: Array.isArray(lead.hours) ? lead.hours.filter((h) => h && h.d && h.h).slice(0, 7) : [],
    services: seed.services,
    // The demo shape, and a colour that suits the trade. Both are free, both
    // are the customer's to change in the panel, and both exist so the first
    // render is a real page instead of four blocks.
    theme: seed.theme,
    layout: seed.layout,
    posts: [],
    modules: ['P0'],      // the free site only, nothing paid switched on
    published: false,     // INVISIBLE until a person publishes it
    source: 'draft-bulk',
    leadId: lead.id || '',
    proposed: lead.google_summary ? { about: String(lead.google_summary).slice(0, 600) } : {},
    proposedNote: lead.google_summary ? 'description from their Google listing, not the owner' : '',
  };
}
