// FIRST-RENDER CONTENT for a brand new site record.
//
// THE RULE THIS OBEYS, inherited from lib/draft-site.js: only facts we actually
// hold. No years in business, no "family run since 1998", no review counts, no
// awards, no owner name. The owner reads this page back to you on the delivery
// call, so an invented sentence is worse than an empty one. Everything the
// about line says is assembled from the business name, the trade and the town,
// which are the three things signup actually gives us.
//
// TRADE IS FRAMING, NEVER A SERVICE LIST. Category alone may choose the label,
// the theme, the layout and the schema.org subtype, and it may frame copy at
// the category level ("a plumbing business in Kansas City"). It may NOT
// enumerate specific services: "drain cleaning, water heaters" printed under a
// shop's own name is a factual claim about what that shop sells, and a trade
// table is not evidence of it. Specific services render only from owner or
// intake data (the /start form, the voice agent, the panel, an operator in
// /master) — never from here.
//
// This file owns the trade table. lib/draft-site.js imports it from here rather
// than keeping a second copy, because two lists of what a plumber is called
// will disagree eventually and nobody will notice which one the page used.

export const TRADES = {
  'auto repair':    { label: 'Auto repair',         theme: 'bold' },
  electrician:      { label: 'Electrician',         theme: 'bold' },
  'nails/beauty':   { label: 'Nail & beauty salon', theme: 'warm' },
  'pet groomer':    { label: 'Pet grooming',        theme: 'warm' },
  bakery:           { label: 'Bakery',              theme: 'warm' },
  'cafe/coffee':    { label: 'Cafe',                theme: 'warm' },
  hvac:             { label: 'Heating & cooling',   theme: 'bold' },
  plumber:          { label: 'Plumbing',            theme: 'bold' },
  'salon/barber':   { label: 'Hair salon & barber', theme: 'warm' },
  florist:          { label: 'Florist',             theme: 'warm' },
  painter:          { label: 'Painting',            theme: 'bold' },
  cleaning:         { label: 'Cleaning',            theme: 'clean' },
  roofer:           { label: 'Roofing',             theme: 'bold' },
  landscaper:       { label: 'Landscaping',         theme: 'warm' },
  'gym/fitness':    { label: 'Gym & fitness',       theme: 'midnight' },
  restaurant:       { label: 'Restaurant',          theme: 'warm' },
  'clinic/doctor':  { label: 'Clinic',              theme: 'coastal' },
  dentist:          { label: 'Dental practice',     theme: 'coastal' },
  vet:              { label: 'Veterinary practice', theme: 'coastal' },
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
 * publish it or change what it is entitled to. It also never returns a service
 * list: category is framing, not evidence of what a shop sells.
 */
export function seedSite({ business, trade, city, state } = {}) {
  return {
    tagline: seedTagline({ trade, city, state }),
    about: seedAbout({ business, trade, city, state }),
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
