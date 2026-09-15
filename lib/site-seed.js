// FIRST-RENDER CONTENT for a brand new site record.
//
// THE PROBLEM, measured rather than felt. A free site with no services and no
// about renders as four blocks: nav, hero, contact, footer. That is 9,546 bytes
// and ONE section. The demo we sell with, /demos/auto-tech-shawnee, is 19,048
// bytes. So a customer signs up, opens the site we built them, and sees a page
// that looks unfinished, because it is. Changing the LAYOUT alone does not fix
// it: the same empty record in the Trade layout is 12,146 bytes and still one
// section. A better shape with nothing in it is still nothing in it.
//
// THE RULE THIS OBEYS, inherited from lib/draft-site.js: only facts we actually
// hold. No years in business, no "family run since 1998", no review counts, no
// awards, no owner name. The owner reads this page back to you on the delivery
// call, so an invented sentence is worse than an empty one. Everything the
// about line says is assembled from the business name, the trade and the town,
// which are the three things signup actually gives us.
//
// The SERVICE LIST is the one generated thing, and it is a trade's standard
// menu rather than a claim about this shop. It exists so the page is not empty
// and so the delivery call has something concrete to correct ("that is a guess,
// tell me what is wrong"). The three medical trades get an empty list on
// purpose: a wrong service list for a clinic is a different class of mistake to
// a wrong one for a barber.
//
// Menu items are nouns for work a trade does, never promises the shop has not
// made: no "Emergency service", "Same-day delivery", "Free estimates" or
// "Insurance claims help". A service the shop does not offer is correctable on
// the delivery call; a commitment it never made, printed under its own name,
// is a fabrication.
//
// This file owns the trade table. lib/draft-site.js imports it from here rather
// than keeping a second copy, because two lists of what a plumber does will
// disagree eventually and nobody will notice which one the page used.

const S = (...names) => names.map((n) => ({ name: n, desc: '' }));

export const TRADES = {
  'auto repair':    { label: 'Auto repair',         theme: 'bold',     services: S('Brakes', 'Oil & filter change', 'Engine diagnostics', 'Tires & alignment', 'Suspension', 'Pre-purchase inspection') },
  electrician:      { label: 'Electrician',         theme: 'bold',     services: S('Repairs & troubleshooting', 'Panel upgrades', 'Lighting installation', 'Outlets & switches', 'Ceiling fans') },
  'nails/beauty':   { label: 'Nail & beauty salon', theme: 'warm',     services: S('Manicure', 'Pedicure', 'Gel & acrylic', 'Nail art', 'Waxing', 'Lashes & brows') },
  'pet groomer':    { label: 'Pet grooming',        theme: 'warm',     services: S('Full groom', 'Bath & brush', 'Nail trim', 'De-shedding', 'Ear cleaning', 'Puppy first groom') },
  bakery:           { label: 'Bakery',              theme: 'warm',     services: S('Fresh bread', 'Pastries', 'Custom cakes', 'Celebration orders', 'Coffee', 'Catering trays') },
  'cafe/coffee':    { label: 'Cafe',                theme: 'warm',     services: S('Espresso & coffee', 'Breakfast', 'Lunch', 'Pastries', 'Cold drinks', 'Catering') },
  hvac:             { label: 'Heating & cooling',   theme: 'bold',     services: S('AC repair', 'Furnace repair', 'System installation', 'Seasonal tune-ups', 'Ductwork') },
  plumber:          { label: 'Plumbing',            theme: 'bold',     services: S('Leak repair', 'Drain cleaning', 'Water heaters', 'Fixture installation', 'Repiping') },
  'salon/barber':   { label: 'Hair salon & barber', theme: 'warm',     services: S('Haircut', 'Beard trim', 'Color', 'Styling', 'Kids cuts', 'Hot towel shave') },
  florist:          { label: 'Florist',             theme: 'warm',     services: S('Bouquets', 'Weddings', 'Funeral tributes', 'Plants & gifts', 'Event flowers') },
  painter:          { label: 'Painting',            theme: 'bold',     services: S('Interior painting', 'Exterior painting', 'Cabinet refinishing', 'Drywall repair', 'Pressure washing') },
  cleaning:         { label: 'Cleaning',            theme: 'clean',    services: S('Regular house cleaning', 'Deep clean', 'Move in & move out', 'Office cleaning', 'Carpets', 'One-off jobs') },
  roofer:           { label: 'Roofing',             theme: 'bold',     services: S('Roof repair', 'Full replacement', 'Storm damage', 'Gutters', 'Inspections') },
  landscaper:       { label: 'Landscaping',         theme: 'warm',     services: S('Lawn care', 'Design & planting', 'Hardscaping', 'Clean-ups', 'Irrigation', 'Tree & shrub work') },
  'gym/fitness':    { label: 'Gym & fitness',       theme: 'midnight', services: S('Memberships', 'Personal training', 'Group classes', 'Open gym', 'Day passes', 'Nutrition coaching') },
  restaurant:       { label: 'Restaurant',          theme: 'warm',     services: S('Dine in', 'Takeaway', 'Catering', 'Private events', 'Daily specials', 'Online ordering') },
  // Medical: name, trade, phone and address only. We do not guess a clinical menu.
  'clinic/doctor':  { label: 'Clinic',              theme: 'coastal',  services: [] },
  dentist:          { label: 'Dental practice',     theme: 'coastal',  services: [] },
  vet:              { label: 'Veterinary practice', theme: 'coastal',  services: [] },
};

/** The deterministic fallback when the trade is unknown or blank. */
export const FALLBACK_LABEL = 'Local business';
export const FALLBACK_THEME = 'warm';
/** The shape the demo established. New free sites are seeded into it deliberately. */
export const SEED_LAYOUT = 'trade';

const key = (trade) => String(trade == null ? '' : trade).trim().toLowerCase();

/** The trade record, or null when we do not recognise the trade. */
export function tradeEntry(trade) {
  return TRADES[key(trade)] || null;
}

/** Human label for a trade, falling back to the raw string then to a generic. */
export function tradeLabel(trade) {
  const t = tradeEntry(trade);
  if (t) return t.label;
  const raw = String(trade == null ? '' : trade).trim();
  return raw || FALLBACK_LABEL;
}

/** Fresh copies, never the shared objects, so an edit to one site cannot reach another. */
export function servicesForTrade(trade) {
  const t = tradeEntry(trade);
  return t ? t.services.map((s) => ({ ...s })) : [];
}

/** A colour that suits the trade. Deterministic, and always a theme we ship. */
export function themeForTrade(trade) {
  const t = tradeEntry(trade);
  return (t && t.theme) || FALLBACK_THEME;
}

const vowel = (w) => /^[aeiou]/i.test(String(w || ''));

// Some labels are already a noun for the business ("veterinary practice",
// "bakery", "hair salon & barber") and some are a category of work ("heating &
// cooling", "plumbing"). The first kind reads wrong with "business" bolted on
// ("a veterinary practice business"), the second reads wrong without it ("a
// heating & cooling"). One suffix test picks the right sentence for both.
const NOUN_TAIL = /(practice|salon|clinic|bakery|cafe|restaurant|florist|gym|barber|shop|studio|electrician)$/i;

/**
 * One factual sentence, and only ever facts.
 *
 * Reads as "Old School Iron is a gym & fitness business in Kansas City, MO."
 * Every clause comes off the record. With no town it stops early rather than
 * reaching for filler, and with no business name it returns '', because a page
 * is better empty than wrong.
 *
 * Capped well under the 600 the panel accepts; the cap is enforced anyway so a
 * pathological business name cannot overflow the field.
 */
export function seedAbout({ business, trade, city, state } = {}) {
  const name = String(business == null ? '' : business).trim();
  if (!name) return '';
  const label = tradeLabel(trade);
  const where = [String(city || '').trim(), String(state || '').trim()].filter(Boolean).join(', ');
  const lower = label.toLowerCase();
  const article = vowel(lower) ? 'an' : 'a';
  const what = label === FALLBACK_LABEL
    ? `${article} local business`
    : (NOUN_TAIL.test(lower) ? `${article} ${lower}` : `${article} ${lower} business`);
  const sentence = where ? `${name} is ${what} in ${where}.` : `${name} is ${what}.`;
  return sentence.slice(0, 600);
}

/** "Auto repair in Shawnee, KS", the same factual line draftFromLead already builds. */
export function seedTagline({ trade, city, state } = {}) {
  const label = tradeLabel(trade);
  const where = [String(city || '').trim(), String(state || '').trim()].filter(Boolean).join(', ');
  if (!where) return label === FALLBACK_LABEL ? '' : label;
  return `${label} in ${where}`;
}

/**
 * Everything a new record needs to render as a real page on its first serve.
 *
 * Returns only content fields. It never returns a slug, an email, a published
 * flag or a module list, so it cannot be spread over a record and quietly
 * publish it or change what it is entitled to.
 */
export function seedSite({ business, trade, city, state } = {}) {
  return {
    tagline: seedTagline({ trade, city, state }),
    about: seedAbout({ business, trade, city, state }),
    services: servicesForTrade(trade),
    theme: themeForTrade(trade),
    layout: SEED_LAYOUT,
  };
}

/**
 * Fill ONLY the fields that are empty. This is the guard that makes seeding safe
 * to run against a record that already exists: anything the customer typed, or
 * an operator wrote, wins over anything generated here. An empty string, an
 * empty array and a missing key count as empty; a value the customer set does
 * not. Returns a patch, never a whole record, so a caller cannot use it to
 * clobber fields it did not mean to touch.
 */
export function seedMissing(site = {}) {
  const seed = seedSite(site);
  const patch = {};
  for (const [k, v] of Object.entries(seed)) {
    const cur = site[k];
    const blank = cur == null || cur === '' || (Array.isArray(cur) && cur.length === 0);
    const seedIsEmpty = Array.isArray(v) ? v.length === 0 : v === '';
    if (blank && !seedIsEmpty) patch[k] = v;
  }
  return patch;
}
