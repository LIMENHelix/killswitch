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

const S = (...names) => names.map((n) => ({ name: n, desc: '' }));

const TRADES = {
  'auto repair':    { label: 'Auto repair',        services: S('Brakes', 'Oil & filter change', 'Engine diagnostics', 'Tires & alignment', 'Suspension', 'Pre-purchase inspection') },
  electrician:      { label: 'Electrician',        services: S('Repairs & troubleshooting', 'Panel upgrades', 'Lighting installation', 'Outlets & switches', 'Ceiling fans', 'Emergency service') },
  'nails/beauty':   { label: 'Nail & beauty salon', services: S('Manicure', 'Pedicure', 'Gel & acrylic', 'Nail art', 'Waxing', 'Lashes & brows') },
  'pet groomer':    { label: 'Pet grooming',       services: S('Full groom', 'Bath & brush', 'Nail trim', 'De-shedding', 'Ear cleaning', 'Puppy first groom') },
  bakery:           { label: 'Bakery',             services: S('Fresh bread', 'Pastries', 'Custom cakes', 'Celebration orders', 'Coffee', 'Catering trays') },
  'cafe/coffee':    { label: 'Cafe',               services: S('Espresso & coffee', 'Breakfast', 'Lunch', 'Pastries', 'Cold drinks', 'Catering') },
  hvac:             { label: 'Heating & cooling',  services: S('AC repair', 'Furnace repair', 'System installation', 'Seasonal tune-ups', 'Ductwork', 'Emergency service') },
  plumber:          { label: 'Plumbing',           services: S('Leak repair', 'Drain cleaning', 'Water heaters', 'Fixture installation', 'Repiping', 'Emergency service') },
  'salon/barber':   { label: 'Hair salon & barber', services: S('Haircut', 'Beard trim', 'Color', 'Styling', 'Kids cuts', 'Hot towel shave') },
  florist:          { label: 'Florist',            services: S('Bouquets', 'Weddings', 'Funeral tributes', 'Same-day delivery', 'Plants & gifts', 'Event flowers') },
  painter:          { label: 'Painting',           services: S('Interior painting', 'Exterior painting', 'Cabinet refinishing', 'Drywall repair', 'Pressure washing', 'Free estimates') },
  cleaning:         { label: 'Cleaning',           services: S('Regular house cleaning', 'Deep clean', 'Move in & move out', 'Office cleaning', 'Carpets', 'One-off jobs') },
  roofer:           { label: 'Roofing',            services: S('Roof repair', 'Full replacement', 'Storm damage', 'Gutters', 'Inspections', 'Insurance claims help') },
  landscaper:       { label: 'Landscaping',        services: S('Lawn care', 'Design & planting', 'Hardscaping', 'Clean-ups', 'Irrigation', 'Tree & shrub work') },
  'gym/fitness':    { label: 'Gym & fitness',      services: S('Memberships', 'Personal training', 'Group classes', 'Open gym', 'Day passes', 'Nutrition coaching') },
  restaurant:       { label: 'Restaurant',         services: S('Dine in', 'Takeaway', 'Catering', 'Private events', 'Daily specials', 'Online ordering') },
  // Medical: name, trade, phone and address only. We do not guess a clinical menu.
  'clinic/doctor':  { label: 'Clinic', services: [] },
  dentist:          { label: 'Dental practice', services: [] },
  vet:              { label: 'Veterinary practice', services: [] },
};

export function tradeLabel(trade) {
  const t = TRADES[String(trade || '').toLowerCase()];
  return (t && t.label) || (trade ? String(trade) : 'Local business');
}

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

  const trade = String(lead.trade || '').toLowerCase();
  const cfg = TRADES[trade];
  const where = [lead.city, lead.state].filter(Boolean).join(', ');

  return {
    slug,
    business,
    trade: cfg ? cfg.label : (lead.trade || ''),
    // Factual: what they do and where. Nothing claimed beyond the lead record.
    tagline: where ? `${cfg ? cfg.label : 'Local business'} in ${where}` : (cfg ? cfg.label : ''),
    phone: String(lead.phone || '').trim(),
    street: String(lead.street || '').trim(),
    city: String(lead.city || '').trim(),
    state: String(lead.state || '').trim(),
    zip: String(lead.zip || '').trim(),
    email: '',            // no lead in this list has one, so there is nobody to attach
    email_public: '',
    // WHO SAID IT DECIDES WHERE IT GOES.
    // Opening hours on Google are published by the business itself, so they are
    // theirs and they go live. An editorial summary is Google's description OF
    // them, which is a different thing, so it waits in `proposed` for a human
    // exactly like anything else we did not hear from the owner.
    about: '',
    hours: Array.isArray(lead.hours) ? lead.hours.filter((h) => h && h.d && h.h).slice(0, 7) : [],
    services: cfg ? cfg.services.map((s) => ({ ...s })) : [],
    posts: [],
    modules: ['P0'],      // the free site only, nothing paid switched on
    published: false,     // INVISIBLE until a person publishes it
    source: 'draft-bulk',
    leadId: lead.id || '',
    proposed: lead.google_summary ? { about: String(lead.google_summary).slice(0, 600) } : {},
    proposedNote: lead.google_summary ? 'description from their Google listing, not the owner' : '',
  };
}
