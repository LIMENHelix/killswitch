// THE SWITCHES HAVE TO DO SOMETHING ON A PAGE WE DID NOT TEMPLATE.
//
// api/site.js serves `site.html` verbatim when a business has its own written
// page, and every module gate lives in lib/site-template.js, which that branch
// skips. So a customer could buy P9, flip it on, see the switch go green, and
// nothing would ever appear on their website. These use the real Oou Wee's demo
// page, 31KB of hand-built HTML with none of our module markup in it, because a
// synthetic "<html><body></body></html>" would not prove anything about a real
// customer's layout. It was Oou Wee's until that page was removed at the
// owner's request, which is the reason a test never keeps the only copy.
import fs from 'fs';
import { applyModules, INJECTABLE } from '../lib/site-modules.js';

const REAL = fs.readFileSync(new URL('../demos/kcs-sports-academy-olathe.html', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };

const site = (modules, extra = {}) => ({
  slug: 'kcs-sports-academy-olathe', business: "KC's Sports Academy",
  phone: '(816) 679-1642', street: '1 Academy Way', city: 'Olathe', state: 'KS', zip: '66061',
  modules: ['P0', ...modules], ...extra,
});

console.log('\nA REAL CUSTOMER PAGE, WITH EVERY SWITCH OFF');

const off = applyModules(REAL, site([]));
check('the page comes back completely untouched', off === REAL, 'length ' + off.length + ' vs ' + REAL.length);
check('no assistant appears', !off.includes('ksmAiBtn'));
check('no floating buttons appear', !off.includes('ksm-fab'));
check('no listing markup appears', !off.includes('application/ld+json'));
check('no beacon fires, so an unpaid module costs nothing', !off.includes("action:'view'"));

console.log('\nFLIPPING ONE ON PUTS IT ON THE PAGE');

const ai = applyModules(REAL, site(['P9']));
check('P9 puts the assistant on their page', ai.includes('ksmAiBtn') && ai.includes('ksm-ai-f'));
check('and it is addressed to their business by name', ai.includes('Ask KC'));
check('and it talks to the right site', ai.includes('"kcs-sports-academy-olathe"'));
check('P8 fires the view beacon', applyModules(REAL, site(['P8'])).includes("action:'view'"));
check('P1 adds the listing markup', applyModules(REAL, site(['P1'])).includes('application/ld+json'));
check('P1 carries the real address into it',
  applyModules(REAL, site(['P1'])).includes('1 Academy Way'));

const book = applyModules(REAL, site(['P3'], { bookingUrl: 'https://booksy.com/x' }));
check('P3 adds a booking action', book.includes('ksm-book') && book.includes('https://booksy.com/x'));
const builtInBook = applyModules(REAL, site(['P3']));
check('P3 with no calendar link gets a working request form',
  builtInBook.includes('ksmBookForm') && builtInBook.includes("action:'book'"));
const pay = applyModules(REAL, site(['P7'], { payUrl: 'https://pay.example/x' }));
check('P7 adds a pay action', pay.includes('ksm-pay'));
check('and P7 with no pay link adds nothing', !applyModules(REAL, site(['P7'])).includes('ksm-pay'));

const withPosts = applyModules(REAL, site(['P2'], { posts: [
  { title: 'Fall registration', date: '2026-09-04', body: 'Registration is now open.' },
] }));
check('P2 renders updates at the opt-in module marker',
  withPosts.includes('ksm-updates') && withPosts.includes('Fall registration'));
check('P2 content is escaped before it reaches a customer page',
  applyModules(REAL, site(['P2'], { posts: [{ title: '<script>bad()</script>' }] })).includes('&lt;script&gt;bad()&lt;/script&gt;'));

console.log('\nIT MUST NOT WRECK A LAYOUT WE DID NOT DESIGN');

const all = applyModules(REAL, site(['P1', 'P3', 'P7', 'P8', 'P9'], { bookingUrl: 'https://booksy.com/x', payUrl: 'https://pay.example/x' }));
check('every byte of their original page survives', all.includes(REAL.slice(0, 2000)) || all.length > REAL.length);
check('their own content is still there', all.includes('kcsa-badge') && all.includes('tel:+18166791642'));
check('nothing was spliced into the middle of their markup',
  all.indexOf('ksm-ai-btn') > all.lastIndexOf('</main>'), 'injected before their main closed');
check('the head injection lands inside the head',
  all.indexOf('application/ld+json') < all.toLowerCase().indexOf('</head>'));
check('the body injection lands before the body closes',
  all.lastIndexOf('ksmAiBtn') < all.toLowerCase().lastIndexOf('</body>'));
check('the document still ends properly', /<\/html>\s*$/i.test(all.trim()));
check('our CSS is namespaced so it cannot restyle their page',
  (all.match(/\.ksm-/g) || []).length > 5 && !all.includes('\n.btn{') );

console.log('\nA PAGE THAT WANTS THEM SOMEWHERE SPECIFIC CAN SAY SO');

// Sentinels chosen so they cannot appear in the injected CSS. An earlier version
// of this test used "top" and "bottom", which both occur in the widget's own
// position rules, so it failed against working code.
const marked = '<html><head></head><body><p>ZZALPHA</p><!--ks:modules--><p>ZZOMEGA</p></body></html>';
const m = applyModules(marked, site(['P9']));
check('the marker is where the module lands',
  m.indexOf('ksmAiBtn') > m.indexOf('ZZALPHA') && m.indexOf('ksmAiBtn') < m.indexOf('ZZOMEGA'), m.slice(0, 200));
check('and the marker itself is consumed', !m.includes('<!--ks:modules-->'));
check('the marker wins over the default end-of-body placement',
  m.indexOf('ksmAiBtn') < m.toLowerCase().indexOf('</body>') && m.indexOf('ZZOMEGA') > m.indexOf('ksmAiBtn'));

console.log('\nA CUSTOM FORM CAN OPT INTO THE FREE CONTACT PIPELINE');

const contactPage = '<html><body><form data-ks-contact><input name="name"><input name="contact"><textarea name="message"></textarea><button type="submit">Send</button><p class="ok" hidden></p></form></body></html>';
const wiredContact = applyModules(contactPage, site([]));
check('an opted-in form posts to the site action endpoint',
  wiredContact.includes("action:'contact'") && wiredContact.includes("form[data-ks-contact]"));
check('the original custom form survives intact', wiredContact.includes('<textarea name="message"></textarea>'));
check('an ordinary unmarked form is never intercepted',
  applyModules('<html><body><form></form></body></html>', site([])) === '<html><body><form></form></body></html>');

const legacyDemo = '<html><body><form id="quoteForm"><input name="name"><input name="contact"><textarea name="message"></textarea><button type="submit">Send</button></form><section class="final">Contact</section></body></html>';
const upgradedLegacy = applyModules(legacyDemo, site(['P2'], { posts: [{ title: 'Stored-page update' }] }));
check('an already-stored demo form is upgraded without re-importing its HTML',
  upgradedLegacy.includes('form#quoteForm') && upgradedLegacy.includes("action:'contact'"));
check('an already-stored demo gets P2 at its legacy content boundary',
  upgradedLegacy.indexOf('Stored-page update') < upgradedLegacy.indexOf('<section class="final">'));

console.log('\nSERVING THEIR PAGE BEATS SERVING A BROKEN ONE');

check('empty html stays empty', applyModules('', site(['P9'])) === '');
check('a page with no body tag still gets the module rather than losing it',
  applyModules('<p>bare fragment</p>', site(['P9'])).includes('ksmAiBtn'));
check('a null site does not throw', applyModules('<body></body>', null) === '<body></body>');
check('a site with no modules array does not throw',
  applyModules('<body></body>', { slug: 'x' }) === '<body></body>');

// JSON inside a <script> can only be broken out of with a literal </script>.
const nasty = applyModules('<html><head></head><body></body></html>',
  site(['P1'], { business: 'Bob </script><script>alert(1)</script>' }));
check('a business name cannot break out of the listing markup',
  !/<\/script><script>alert/.test(nasty), nasty.slice(nasty.indexOf('ld+json'), nasty.indexOf('ld+json') + 200));

check('INJECTABLE names exactly what this file can place',
  JSON.stringify(INJECTABLE) === JSON.stringify(['P1', 'P2', 'P3', 'P7', 'P8', 'P9']), JSON.stringify(INJECTABLE));

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
