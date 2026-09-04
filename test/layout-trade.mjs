// THE TRADE LAYOUT, ACROSS EVERY COLOUR AND BOTH KINDS OF RECORD.
//
// Two axes now exist: `layout` is the SHAPE, `theme` is the COLOUR. That makes
// the surface multiplicative, so this renders Trade x 5 themes x {a full
// record, a sparse one} and checks each. A layout that only works when the
// record is complete is not a layout, it is a demo.
//
// Three things it is really guarding:
//   1. layout:'' renders the ORIGINAL page. Shipping a layout must change
//      nobody's live site. Same contract as theme:'' meaning warm.
//   2. NOTHING FROM THE DEMO LEAKS. demos/auto-tech-shawnee.html is a
//      hand-built file containing one business's phone, address, star rating
//      and certifications. The layout ports its treatment, never its facts.
//   3. A sparse record degrades to something honest: sections that have no
//      data are absent, not present-and-empty.
import path from 'node:path';
import fs from 'node:fs';
const ROOT = path.join(import.meta.dirname, '..');

const { renderSite, THEMES, THEME_NAMES, LAYOUTS, LAYOUT_NAMES, DEFAULT_LAYOUT,
  isLayout, layoutFor, onAccent, FACTORY_ACCENT } = await import('../lib/site-template.js');
const { SITE_DEFAULT } = await import('../lib/sites.js');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };

const FULL = {
  ...SITE_DEFAULT, slug: 'auto-tech', business: 'Auto Tech Services Center',
  trade: 'Auto repair', tagline: 'Straight answers and fair prices.',
  phone: '(816) 555-0142', email_public: 'shop@example.test',
  street: '4120 W 95th St', city: 'Overland Park', state: 'KS', zip: '66212',
  about: 'Independent shop.', hours: [{ d: 'Mon to Fri', h: '8am to 6pm' }],
  services: [{ name: 'Brakes', desc: 'Pads and rotors' }, { name: 'Oil change', desc: '' }],
  posts: [{ title: 'Winter check', body: 'Book early.', date: '2026-01-02' }],
  bookingUrl: 'https://example.com/book', payUrl: 'https://example.com/pay',
  modules: ['P0', 'P1', 'P2', 'P3', 'P7', 'P8', 'P9'], published: true, claimed: true, layout: 'trade',
};
// Solid Ground Engineering's REAL shape on the day this was written: a name, a
// trade, a town, a phone, and nothing else. No services, no hours, no about,
// free tier only.
const SPARSE = {
  ...SITE_DEFAULT, slug: 'solid-ground-engineering', business: 'Solid Ground Engineering',
  trade: 'Engineering and Drafting', tagline: 'Engineering and Drafting in Eureka, CA',
  phone: '(619) 549-3274', city: 'Eureka', state: 'CA',
  modules: ['P0'], published: true, claimed: true, layout: 'trade',
};

console.log('\nTHE LAYOUT AXIS FALLS BACK THE WAY THE THEME AXIS DOES');
check("layoutFor('') is the original layout", layoutFor('') === DEFAULT_LAYOUT);
check('layoutFor(undefined) is the original', layoutFor(undefined) === DEFAULT_LAYOUT);
check('layoutFor(garbage) is the original', layoutFor('../../etc/passwd') === DEFAULT_LAYOUT);
check('names are matched case-insensitively', layoutFor('TRADE') === 'trade');
check('isLayout refuses what we do not ship', !isLayout('brutalist') && isLayout('trade'));
check('both layouts are offered', LAYOUT_NAMES.length === 2 && LAYOUT_NAMES.includes('classic'));
check('each carries a label and a plain-English note',
  LAYOUT_NAMES.every((n) => LAYOUTS[n].label && LAYOUTS[n].note));

console.log('\nA RECORD WITH NO LAYOUT RENDERS EXACTLY WHAT IT RENDERED BEFORE');
const asClassic = renderSite({ ...FULL, layout: '' }, {});
check('layout:"" and layout:"classic" are identical',
  asClassic === renderSite({ ...FULL, layout: 'classic' }, {}));
check('an unknown layout falls back to classic, not to a blank page',
  renderSite({ ...FULL, layout: 'nope' }, {}) === asClassic);
check('and classic is NOT the trade markup',
  !asClassic.includes('class="hero-bg"') && renderSite(FULL, {}).includes('class="hero-bg"'));

console.log('\nTRADE x EVERY THEME x FULL RECORD');
for (const t of THEME_NAMES) {
  const h = renderSite({ ...FULL, theme: t }, { base: 'https://killswitchwebsites.com' });
  const ok = h.includes('class="hero-bg"') && h.includes('class="mk"') && h.includes('class="navcall"')
    && h.includes('id="services"') && h.includes('class="band"') && h.includes('class="eyebrow"')
    && h.includes('--bg:' + THEMES[t].bg) && h.includes('--on:' + onAccent(THEMES[t].ac));
  check(`${t}: hero, logo mark, call bar, services, band, eyebrows, correct palette`, ok);
}

console.log('\nTRADE x EVERY THEME x SPARSE RECORD, degrading honestly');
for (const t of THEME_NAMES) {
  const h = renderSite({ ...SPARSE, theme: t }, { base: 'https://killswitchwebsites.com' });
  const structural = h.includes('class="hero-bg"') && h.includes('class="mk"') && h.includes('id="contact"');
  // Absent, not present-and-empty. An empty services grid or a band of blanks
  // is worse than no section, because it reads as broken rather than as new.
  const noEmpties = !h.includes('id="services"') && !h.includes('class="band"')
    && !h.includes('id="book"') && !h.includes('id="pay"') && !h.includes('id="updates"')
    && !h.includes('id="about"') && !h.includes('class="aibtn"');
  check(`${t}: still a real page, and empty sections are absent rather than blank`, structural && noEmpties);
}

console.log('\nNOTHING THE DEMO KNOWS ABOUT ONE BUSINESS LEAKS INTO ANOTHER');
// demos/auto-tech-shawnee.html is hand written. These are its facts.
const DEMO_FACTS = ['913) 268-7887', '9132687887', '11441 Shawnee', 'Shawnee',
  'NAPA', '4.7', '70+', 'Google reviews', 'Google rating'];
let leaks = 0;
for (const t of THEME_NAMES) {
  const h = renderSite({ ...SPARSE, theme: t }, {});
  for (const f of DEMO_FACTS) if (h.includes(f)) { console.log('    LEAK ' + f + ' in ' + t); leaks++; }
}
check('zero demo facts in any Solid Ground render, across all five themes', leaks === 0, String(leaks));
check('the demo file itself is still the hand-built one, untouched',
  fs.readFileSync(path.join(ROOT, 'demos', 'auto-tech-shawnee.html'), 'utf8').includes('NAPA AutoCare'));

console.log('\nA MODULE IS NEVER SHOWN THAT THE RECORD DOES NOT HAVE');
const bare = renderSite({ ...FULL, modules: ['P0'] }, {});
for (const [phase, mark] of [['P3', 'id="book"'], ['P7', 'id="pay"'], ['P2', 'id="updates"'], ['P9', 'class="aibtn"'], ['P1', 'LocalBusiness'], ['P8', "action:'view'"]]) {
  check(`${phase} absent when switched off`, !bare.includes(mark));
  check(`${phase} present when switched on`, renderSite(FULL, {}).includes(mark));
}

console.log('\nCONTRAST IS COMPUTED, NEVER HARDCODED');
for (const t of THEME_NAMES) {
  const h = renderSite({ ...FULL, theme: t }, {});
  check(`${t}: text on the accent comes from onAccent()`, h.includes('--on:' + onAccent(THEMES[t].ac)));
}
const src = fs.readFileSync(path.join(ROOT, 'lib', 'site-template.js'), 'utf8');
const trade = src.slice(src.indexOf('function renderTrade'));
check('the trade layout hardcodes no white-on-accent',
  !/background:var\(--ac\);color:#fff/.test(trade), 'found a hardcoded #fff on the accent');

console.log('\nA CUSTOMER-SET BRAND COLOUR STILL WINS, AS IT DOES IN CLASSIC');
const custom = renderSite({ ...FULL, accent: '#7C3AED', theme: 'midnight' }, {});
check('their colour survives the layout', custom.includes('--ac:#7C3AED'));
check('the theme still supplies the rest', custom.includes('--bg:' + THEMES.midnight.bg));
check('and the text on it is still readable', custom.includes('--on:' + onAccent('#7C3AED')));

console.log('\nTHE PAGE IS STRUCTURALLY WHAT WAS ASKED FOR');
const shipped = renderSite(FULL, { base: 'https://killswitchwebsites.com' });
for (const [what, mark] of [['a logo mark', 'class="mk"'], ['a sticky call bar', 'class="navcall"'],
  ['a full-bleed hero', 'class="hero-bg"'], ['icon-tile service cards', 'class="ic"'],
  ['uppercase eyebrows', 'class="eyebrow"'], ['a real footer', '<footer']]) {
  check(`it has ${what}`, shipped.includes(mark));
}
check('and it escapes a business name that contains markup',
  !renderSite({ ...FULL, business: '<script>x</script>' }, {}).includes('<script>x</script>'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
