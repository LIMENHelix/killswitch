// SEO HYGIENE GUARD — the trade×city programmatic pages are near-clones
// (measured: 18 of 138 lines differ between cities, and those are city-token
// swaps). They were intentionally kept OUT of the index until 2026-10-22,
// when the policy changed to making them indexable and submitting them.
// This test is the tripwire against a partial rollout leaving a city page
// noindexed or missing from the sitemap. The clone/doorway risk is now a
// Search Console monitoring concern, not something this test can police.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };

const files = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
const cityPages = files.filter((f) => /^free-website-for-.+-in-.+\.html$/.test(f));
const tradeHubs = files.filter((f) => /^free-website-for-[a-z-]+\.html$/.test(f) && !f.includes('-in-'));

const sitemap = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');

console.log('\nCITY PAGES ARE INDEXABLE AND SUBMITTED');
check('the city-page set is the expected size', cityPages.length === 200, String(cityPages.length));
const noindexedCities = cityPages.filter((f) =>
  fs.readFileSync(path.join(ROOT, f), 'utf8').includes('noindex'));
check('no city page is noindexed', noindexedCities.length === 0, noindexedCities.slice(0, 3).join(','));
const missingCities = cityPages.filter((f) => !sitemap.includes('/' + f.replace(/\.html$/, '')));
check('every city page is in the sitemap', missingCities.length === 0, missingCities.slice(0, 3).join(','));
const sitemapLocs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
check('the sitemap has no duplicate URLs', new Set(sitemapLocs).size === sitemapLocs.length,
  `${sitemapLocs.length} entries, ${new Set(sitemapLocs).size} unique`);

console.log('\nTRADE HUBS STAY INDEXED AND SUBMITTED');
check('the trade hub set is the expected size', tradeHubs.length === 10, String(tradeHubs.length));
const noindexedHubs = tradeHubs.filter((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').includes('noindex'));
check('no trade hub is noindexed', noindexedHubs.length === 0, noindexedHubs.join(','));
const unsubmittedHubs = tradeHubs.filter((f) => !sitemap.includes('/' + f.replace(/\.html$/, '')));
check('every trade hub is in the sitemap', unsubmittedHubs.length === 0, unsubmittedHubs.join(','));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
