// SEO HYGIENE GUARD — the trade×city programmatic pages are near-clones
// (measured: 18 of 138 lines differ between cities, and those are city-token
// swaps), a doorway-page pattern that puts the whole domain at risk. Until
// they carry independent local value they must stay OUT of the index:
// noindex on the page, absent from the sitemap. The trade hub pages stay
// indexed. This test is the tripwire against regenerating clones indexably.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };

const files = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
const cityPages = files.filter((f) => /^free-website-for-.+-in-.+\.html$/.test(f));
const tradeHubs = files.filter((f) => /^free-website-for-[a-z-]+\.html$/.test(f) && !f.includes('-in-'));

const sitemap = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');

console.log('\nCITY CLONE PAGES ARE NOINDEX AND OUT OF THE SITEMAP');
check('the city-page set is the expected size', cityPages.length === 200, String(cityPages.length));
const missingNoindex = cityPages.filter((f) =>
  !fs.readFileSync(path.join(ROOT, f), 'utf8').includes('<meta name="robots" content="noindex,follow" />'));
check('every city page carries noindex,follow', missingNoindex.length === 0, missingNoindex.slice(0, 3).join(','));
const inSitemap = cityPages.filter((f) => sitemap.includes('/' + f.replace(/\.html$/, '')));
check('no city page is submitted in the sitemap', inSitemap.length === 0, inSitemap.slice(0, 3).join(','));

console.log('\nTRADE HUBS STAY INDEXED AND SUBMITTED');
check('the trade hub set is the expected size', tradeHubs.length === 10, String(tradeHubs.length));
const noindexedHubs = tradeHubs.filter((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').includes('noindex'));
check('no trade hub is noindexed', noindexedHubs.length === 0, noindexedHubs.join(','));
const unsubmittedHubs = tradeHubs.filter((f) => !sitemap.includes('/' + f.replace(/\.html$/, '')));
check('every trade hub is in the sitemap', unsubmittedHubs.length === 0, unsubmittedHubs.join(','));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
