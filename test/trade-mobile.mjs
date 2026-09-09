// TRADE-LAYOUT MOBILE / PRODUCT POLISH.
//
// The delta this guards is presentation-only:
//   1. A real mobile breakpoint pass (full-width CTAs, tighter sections) sits
//      ON TOP of the existing single breakpoint, which only hid the nav links.
//   2. The tab icon is the initials mark as an inline SVG data URI — no file,
//      no request, and no fact in it that did not come off the record.
//   3. A "Get directions" link is built ONLY from address fields on the
//      record. No address, no link. It is a lookup of a known fact, not a
//      claim of one.
//   4. The footer attribution opens in a new tab with noopener, matching the
//      classic layout's treatment.
//   5. Rendering is deterministic: the same record renders byte-identical
//      HTML every time, so retries and re-renders give one effective page.
import { renderSite } from '../lib/site-template.js';
import { SITE_DEFAULT } from '../lib/sites.js';

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };

const FULL = {
  ...SITE_DEFAULT, slug: 'river-auto', business: 'River Auto Repair', trade: 'Auto repair',
  tagline: 'Brakes and diagnostics in Riverton.', phone: '816-555-0142',
  email_public: 'shop@riverauto.test', street: '4120 W 95th St', city: 'Riverton', state: 'KS', zip: '66212',
  about: 'Independent shop, owner operated.', hours: [{ d: 'Mon to Fri', h: '8am to 6pm' }],
  services: [{ name: 'Brakes', desc: '' }], modules: ['P0'], published: true, claimed: true, layout: 'trade',
};
// Same real-world shape as layout-trade.mjs's SPARSE: name, trade, town, phone.
const SPARSE = {
  ...SITE_DEFAULT, slug: 'solid-ground-engineering', business: 'Solid Ground Engineering',
  trade: 'Engineering and Drafting', tagline: 'Engineering and Drafting in Eureka, CA',
  phone: '(619) 549-3274', city: 'Eureka', state: 'CA',
  modules: ['P0'], published: true, claimed: true, layout: 'trade',
};

const fullHtml = renderSite(FULL, { base: 'https://killswitchwebsites.com' });
const sparseHtml = renderSite(SPARSE, { base: 'https://killswitchwebsites.com' });

console.log('\nMOBILE BREAKPOINT PASS IS PART OF THE TRADE STYLESHEET');
check('a 700px breakpoint exists for the mobile pass', fullHtml.includes('@media(max-width:700px)'));
check('CTAs go full-width on a phone', fullHtml.includes('.cta .btn{width:100%;text-align:center}'));
check('sections tighten on a phone', fullHtml.includes('.sec{padding:54px 0}'));
check('the nav-links rule at 640px survives on its own', fullHtml.includes('@media(max-width:640px){.nl{display:none}}'));
check('very small screens drop the card grid to one column', fullHtml.includes('@media(max-width:400px)'));
check('classic layout got none of this (byte-frozen surface)',
  !renderSite({ ...FULL, layout: '' }, { base: 'https://killswitchwebsites.com' }).includes('@media(max-width:700px)'));

console.log('\nTAB ICON AND BROWSER CHROME COME OFF THE RECORD');
check('an inline SVG favicon is present', fullHtml.includes('<link rel="icon" href="data:image/svg+xml,'));
check('the favicon carries the initials, URL-encoded', fullHtml.includes(encodeURIComponent('RA')));
check('the theme colour matches the resolved accent', fullHtml.includes('<meta name="theme-color" content="#'));
check('a custom accent flows through to both', (() => {
  const h = renderSite({ ...FULL, accent: '#5B3CC4' }, { base: 'https://killswitchwebsites.com' });
  return h.includes('<meta name="theme-color" content="#5B3CC4"') && h.includes(encodeURIComponent('fill="#5B3CC4"'));
})());

console.log('\nDIRECTIONS LINK ONLY EVER FOLLOWS A KNOWN ADDRESS');
check('a full record links out to a maps search of its own address',
  fullHtml.includes('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('4120 W 95th St, Riverton, KS, 66212')));
check('the link opens safely', fullHtml.includes('class="mapl"') && fullHtml.includes('rel="noopener"'));
check('a sparse record with no street gets city-level directions only',
  sparseHtml.includes('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('Eureka, CA')));
check('a record with no address facts gets no directions link at all',
  !renderSite({ ...SPARSE, city: '', state: '' }, { base: 'https://killswitchwebsites.com' }).includes('google.com/maps'));

console.log('\nFOOTER ATTRIBUTION MATCHES THE CLASSIC TREATMENT');
check('the Killswitch link opens in a new tab with noopener',
  fullHtml.includes('<a href="https://killswitchwebsites.com" target="_blank" rel="noopener">Killswitch Websites</a>'));

console.log('\nDETERMINISM: A RETRY RENDERS THE SAME PAGE, NOT A NEW ONE');
check('rendering the same record twice is byte-identical', renderSite(FULL, { base: 'https://killswitchwebsites.com' }) === fullHtml);
check('a customer-written about renders verbatim', fullHtml.includes('Independent shop, owner operated.'));

console.log(fail ? `\n${pass} passed, ${fail} FAILED` : `\n${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
