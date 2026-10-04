// FIRST-RENDER CONTENT: does a new site come out as a real page, and does
// seeding stay off a record a human has already touched.
//
// The defect this guards is the one the operator actually reported: a customer
// signs up, opens the site we built them, and it is four blocks. The fix has
// two halves and BOTH are load-bearing, which is why the render checks at the
// bottom assert section counts rather than just field values:
//   - content, so there is something to draw
//   - the Trade layout, so it is drawn the way the demo is
// A record with content in the Classic shape and a record with no content in
// the Trade shape are both still wrong.
//
// The rule under test that matters most: seeding may only ever assemble facts
// already on the record. If a future edit makes seedAbout() reach for a review
// count, an award, a founding year or anything else nobody told us, the
// "invents nothing" block below is what should fail.
import { seedSite, seedAbout, seedTagline, seedMissing,
  themeForTrade, tradeLabel, tradeEntry, TRADES, SEED_LAYOUT,
  FALLBACK_LABEL, FALLBACK_THEME } from '../lib/site-seed.js';
import { draftFromLead } from '../lib/draft-site.js';
import { renderSite, THEME_NAMES, isLayout } from '../lib/site-template.js';
import { SITE_DEFAULT } from '../lib/sites.js';

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };

const sections = (html) => (html.match(/<section[^>]*id="([a-z]+)"/g) || [])
  .map((s) => s.match(/id="([a-z]+)"/)[1]);

// ---------------------------------------------------------------------------
console.log('\n1. A new record is seeded into a real page');

const seed = seedSite({ business: 'Old School Iron', trade: 'gym/fitness', city: 'Kansas City', state: 'MO' });
check('it produces a tagline', seed.tagline === 'Gym & fitness in Kansas City, MO', seed.tagline);
check('it produces an about line', seed.about === 'Old School Iron is a gym & fitness business in Kansas City, MO.', seed.about);
check('it produces NO service list: category is framing, not evidence', !('services' in seed), JSON.stringify(seed.services));
check('it produces a theme we actually ship', THEME_NAMES.includes(seed.theme), seed.theme);
check('it produces a layout that exists', isLayout(seed.layout) && seed.layout === SEED_LAYOUT, seed.layout);
check('and the layout is the demo shape, not the bare one', seed.layout === 'trade');

check('it returns ONLY content fields, never slug/email/published/modules',
  Object.keys(seed).every((k) => ['tagline', 'about', 'theme', 'layout'].includes(k)),
  Object.keys(seed).join(','));

// ---------------------------------------------------------------------------
console.log('\n2. It invents nothing');

const about = seedAbout({ business: 'Acme Auto', trade: 'auto repair', city: 'Shawnee', state: 'KS' });
for (const banned of ['star', 'review', 'award', 'certified', 'since', 'years', 'family', 'trusted', 'best', 'quality', 'experienced']) {
  check(`about never claims "${banned}"`, !about.toLowerCase().includes(banned), about);
}
check('about is assembled only from name, trade and town',
  about === 'Acme Auto is an auto repair business in Shawnee, KS.', about);
check('no business name means no sentence, not a sentence about nobody',
  seedAbout({ business: '', trade: 'bakery', city: 'KC' }) === '');
check('no town means it stops early rather than reaching for filler',
  seedAbout({ business: 'Acme', trade: 'bakery' }) === 'Acme is a bakery.');
check('about is capped under the field limit',
  seedAbout({ business: 'X'.repeat(5000), trade: 'bakery', city: 'KC', state: 'MO' }).length <= 600);

check('no trade invents a service menu any more, medical or not',
  ['clinic/doctor', 'dentist', 'vet', 'auto repair', 'plumber', 'salon/barber']
    .every((t) => !('services' in seedSite({ business: 'X', trade: t, city: 'KC', state: 'MO' }))));
check('but they still get a factual about line',
  seedAbout({ business: 'Paws', trade: 'vet', city: 'Lenexa', state: 'KS' }) === 'Paws is a veterinary practice in Lenexa, KS.');

// ---------------------------------------------------------------------------
console.log('\n3. Every trade in the table produces usable copy');

for (const t of Object.keys(TRADES)) {
  const s = seedSite({ business: 'Acme', trade: t, city: 'Olathe', state: 'KS' });
  check(`${t}: about reads as a sentence`, /^Acme is an? .+ in Olathe, KS\.$/.test(s.about), s.about);
  check(`${t}: theme is one we ship`, THEME_NAMES.includes(s.theme), s.theme);
  check(`${t}: category alone yields no service list`, !('services' in s));
}

// ---------------------------------------------------------------------------
console.log('\n4. Unknown and blank trades fall back deterministically');

check('a blank trade gets the generic label', tradeLabel('') === FALLBACK_LABEL);
check('a blank trade gets the fallback theme', themeForTrade('') === FALLBACK_THEME);
check('a blank trade gets no invented services', !('services' in seedSite({ business: 'X', trade: '', city: 'KC' })));
check('an unrecognised trade keeps what the lead said', tradeLabel('taxidermy') === 'taxidermy');
check('an unrecognised trade still gets a shipped theme', THEME_NAMES.includes(themeForTrade('taxidermy')));
check('and no services are guessed for it', !('services' in seedSite({ business: 'X', trade: 'taxidermy', city: 'KC' })));
check('lookup is case and whitespace insensitive',
  tradeEntry('  AUTO REPAIR  ') === tradeEntry('auto repair'));
check('a blank trade with no town produces no tagline rather than a stub',
  seedTagline({ trade: '', city: '', state: '' }) === '');
check('seeding is deterministic: same input, same output',
  JSON.stringify(seedSite({ business: 'A', trade: 'hvac', city: 'KC', state: 'MO' }))
  === JSON.stringify(seedSite({ business: 'A', trade: 'hvac', city: 'KC', state: 'MO' })));

// ---------------------------------------------------------------------------
console.log('\n5. seedMissing NEVER overwrites what a human put there');

const customerWrote = {
  business: 'Old School Iron', trade: 'gym/fitness', city: 'Kansas City', state: 'MO',
  tagline: 'Lift heavy. Go home.',
  about: 'We opened in 2011 and we know every member by name.',
  services: [{ name: 'Powerlifting coaching', desc: 'One to one' }],
  theme: 'bold',
  layout: 'classic',
};
const patch = seedMissing(customerWrote);
check('a record the customer filled in gets an EMPTY patch',
  Object.keys(patch).length === 0, JSON.stringify(patch));

for (const field of ['tagline', 'about', 'theme', 'layout']) {
  const partial = { ...customerWrote };
  delete partial[field];
  const p = seedMissing(partial);
  check(`only the missing ${field} is filled, nothing else is touched`,
    Object.keys(p).length === 1 && Object.keys(p)[0] === field, JSON.stringify(p));
}

check('an empty string counts as missing', 'about' in seedMissing({ ...customerWrote, about: '' }));
check('an empty service list is NOT filled from category — only owner data adds services',
  !('services' in seedMissing({ ...customerWrote, services: [] })));
check('a customer service list of one is NOT topped up',
  !('services' in seedMissing({ ...customerWrote, services: [{ name: 'Just this', desc: '' }] })));
check('a medical record with no services is left empty rather than filled',
  !('services' in seedMissing({ business: 'Paws', trade: 'vet', services: [] })));

// ---------------------------------------------------------------------------
console.log('\n6. draftFromLead still obeys who-said-it, and now seeds');

const d = draftFromLead({
  id: 'Z', name: 'Hours Shop', trade: 'bakery', phone: '816-555-3333', city: 'KC', state: 'MO',
  hours: [{ d: 'Mon to Fri', h: '7am to 3pm' }],
  google_summary: 'A neighborhood bakery known for sourdough.',
}, new Set());

check("Google's words still do NOT reach the live about field",
  !d.about.toLowerCase().includes('sourdough') && !d.about.toLowerCase().includes('neighborhood'), d.about);
check("Google's words still wait in `proposed` for a human",
  d.proposed.about.includes('sourdough') && d.proposedNote.includes('not the owner'));
check('their own published hours still go live', d.hours.length === 1);
check('the draft is still unpublished', d.published === false);
check('the draft is still free-tier only', JSON.stringify(d.modules) === JSON.stringify(['P0']));
check('but about is now seeded rather than blank', d.about === 'Hours Shop is a bakery in KC, MO.', d.about);
check('and the draft carries the demo shape', d.layout === 'trade' && THEME_NAMES.includes(d.theme));

// The bug this exists to catch: the table is keyed by 'hvac' but the label is
// 'Heating & cooling', so seeding from the STORED label finds nothing.
const hv = draftFromLead({ id: 'H', name: 'Ace Heating', trade: 'hvac', city: 'Olathe', state: 'KS' }, new Set());
check('a trade whose label is not its key is still seeded',
  hv.about === 'Ace Heating is a heating & cooling business in Olathe, KS.', hv.about);
check('and the stored trade is still the human label', hv.trade === 'Heating & cooling');
check('but no service list comes from category alone', hv.services.length === 0);

const ownSvc = draftFromLead({ id: 'S', name: 'Listed Shop', trade: 'bakery', city: 'KC', state: 'MO',
  services: [{ name: 'Sourdough', desc: 'Baked daily' }, { name: '', desc: 'skip me' }] }, new Set());
check('owner or intake services DO land on the draft', ownSvc.services.length === 1 && ownSvc.services[0].name === 'Sourdough',
  JSON.stringify(ownSvc.services));

const anon = draftFromLead({ id: 'W', name: 'Mystery Co' }, new Set());
check('a lead with no trade at all still produces a record', !!anon && anon.slug === 'mystery-co');
check('with a factual about and no guessed services',
  anon.about === 'Mystery Co is a local business.' && anon.services.length === 0);

// ---------------------------------------------------------------------------
console.log('\n7. The point of all of it: the page is no longer four blocks');

const bare = { ...SITE_DEFAULT, slug: 'old-school-iron', business: 'Old School Iron',
  trade: 'Gym & fitness', city: 'Kansas City', state: 'MO', phone: '816-555-0100',
  modules: ['P0'], published: true, services: [], about: '' };

const bareHtml = renderSite(bare, { base: 'https://sunflowerwebsites.com' });
const seeded = { ...bare, ...seedMissing({ ...bare, trade: 'gym/fitness' }) };
const seededHtml = renderSite(seeded, { base: 'https://sunflowerwebsites.com' });

check('the bare record really is the reported defect: one section',
  sections(bareHtml).length === 1, sections(bareHtml).join(','));
check('the seeded record renders about and contact',
  ['about', 'contact'].every((s) => sections(seededHtml).includes(s)),
  sections(seededHtml).join(','));
check('and it does NOT invent a services section to get there',
  !sections(seededHtml).includes('services'));
check('and it is materially bigger than the bare page',
  seededHtml.length > bareHtml.length,
  `${bareHtml.length} -> ${seededHtml.length}`);

// BOTH halves are required. Content in the old shape is still not the demo.
const seededClassic = renderSite({ ...seeded, layout: 'classic' }, { base: 'https://sunflowerwebsites.com' });
check('content alone is not enough: Classic still lacks the about section',
  !sections(seededClassic).includes('about'), sections(seededClassic).join(','));
check('the Trade shape is what carries it', sections(seededHtml).includes('about'));

// Every colour must survive the seeded record, since seeding now picks one.
for (const t of THEME_NAMES) {
  const html = renderSite({ ...seeded, theme: t }, { base: 'https://sunflowerwebsites.com' });
  check(`theme ${t} renders the seeded page`, html.length > 12000 && html.includes('Old School Iron'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
