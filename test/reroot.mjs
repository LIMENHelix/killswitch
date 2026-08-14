// THE SAME BYTES AT A NEW ADDRESS ARE NOT THE SAME PAGE.
//
// The real failure this comes from: a demo page carries a RELATIVE asset path
// like src="assets/badge.png". At /demos/<page> that resolves to /demos/assets/
// and is correct. Served from /s/<slug> the browser resolves it against /s/ and
// the business's own logo 404s off their own website. Nothing errors: the HTML
// is valid, the file is there, the address moved.
//
// Uses KC's Sports Academy because it has the same shape. It was originally
// Oou Wee's, whose page was removed from the repo when the owner asked for it
// to be taken down, which is exactly why a test must not be the only copy of
// a customer's content.
import fs from 'fs';
import { rerootRelativeUrls } from '../lib/site-modules.js';

const REAL = fs.readFileSync(new URL('../demos/kcs-sports-academy-olathe.html', import.meta.url), 'utf8');
const SRC = '/demos/kcs-sports-academy-olathe';
const ASSET = 'assets/kcsa-badge.png';

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };

console.log('\nTHE ACTUAL BUG, ON THE ACTUAL PAGE');

check('the real page really does carry a relative asset, or this test proves nothing',
  REAL.includes('src="' + ASSET + '"'));

const fixed = rerootRelativeUrls(REAL, SRC);
check('the asset is re-rooted to where the file actually is',
  fixed.includes('src="/demos/' + ASSET + '"'), (fixed.match(/src="[^"]*kcsa[^"]*"/) || [''])[0]);
check('and the broken relative form is gone', !fixed.includes('src="' + ASSET + '"'));

console.log('\nWHAT MUST NOT BE TOUCHED');

check('their outbound citations are left alone', fixed.includes('https://doi.org/10.1007/s40279-021-01523-9'));
check('Google Fonts is left alone', fixed.includes('https://fonts.googleapis.com/css2?'));
check('the tel: link is left alone', fixed.includes('tel:+18166791642'));
// The strongest form of "nothing else changed": diff it line by line and name
// every line that moved. The logo appears TWICE on this page, in the header and
// again in the hero, so two lines differing is correct and one would be a bug.
const before = REAL.split('\n'), after = fixed.split('\n');
const moved = before.map((l, i) => (l === after[i] ? null : i)).filter((i) => i !== null);
check('only lines carrying that asset changed', moved.length > 0 && moved.length <= 3, 'lines ' + JSON.stringify(moved));
check('and every changed line is that asset, nothing else',
  moved.every((i) => before[i].includes(ASSET) && after[i].includes('/demos/' + ASSET)),
  JSON.stringify(moved.map((i) => after[i].trim().slice(0, 70))));

console.log('\nEVERY FORM A RELATIVE URL TAKES');

const page = `<html><head>
<link rel="stylesheet" href="css/site.css">
<style>.hero{background:url(img/hero.jpg)}.b{background:url("./img/b.png")}</style>
</head><body>
<img src="assets/logo.jpg" srcset="assets/logo.jpg 1x, ./assets/logo@2x.jpg 2x">
<video poster="media/still.jpg"></video>
<a href="https://x.test/keep">abs</a><a href="/rooted/keep">rooted</a>
<a href="#anchor">anchor</a><a href="mailto:a@b.test">mail</a>
<a href="tel:+15551234">tel</a><img src="//cdn.test/x.png"><img src="data:image/gif;base64,R0lGOD">
</body></html>`;
const out = rerootRelativeUrls(page, '/demos/shop-page');

check('a relative stylesheet is re-rooted', out.includes('href="/demos/css/site.css"'));
check('a CSS url() is re-rooted', out.includes('url(/demos/img/hero.jpg)'), (out.match(/url\([^)]*hero[^)]*\)/) || [''])[0]);
check('a quoted CSS url() with ./ is re-rooted', out.includes('url("/demos/img/b.png")'), (out.match(/url\([^)]*b\.png[^)]*\)/) || [''])[0]);
check('an img src is re-rooted', out.includes('src="/demos/assets/logo.jpg"'));
check('EVERY srcset candidate is re-rooted, not just the first',
  out.includes('/demos/assets/logo.jpg 1x') && out.includes('/demos/assets/logo@2x.jpg 2x'),
  (out.match(/srcset="[^"]*"/) || [''])[0]);
check('poster is re-rooted', out.includes('poster="/demos/media/still.jpg"'));

check('an absolute URL is untouched', out.includes('href="https://x.test/keep"'));
check('an already-rooted path is untouched', out.includes('href="/rooted/keep"'));
check('an anchor is untouched', out.includes('href="#anchor"'));
check('mailto: is untouched', out.includes('href="mailto:a@b.test"'));
check('tel: is untouched', out.includes('href="tel:+15551234"'));
check('a protocol-relative URL is untouched', out.includes('src="//cdn.test/x.png"'));
check('a data: URI is untouched', out.includes('src="data:image/gif;base64,R0lGOD"'));

console.log('\nIT MUST NEVER MAKE A PAGE WORSE');

check('no source path means the page is returned unchanged', rerootRelativeUrls(page, '') === page);
check('a source at the root has no directory to root to, so nothing changes',
  rerootRelativeUrls(page, '/shop-page') === page);
check('empty html stays empty', rerootRelativeUrls('', SRC) === '');
check('a query string on the source is ignored, not treated as a path',
  rerootRelativeUrls('<img src="a.jpg">', '/demos/x?v=2').includes('src="/demos/a.jpg"'),
  rerootRelativeUrls('<img src="a.jpg">', '/demos/x?v=2'));
check('running it twice changes nothing the second time',
  rerootRelativeUrls(rerootRelativeUrls(page, '/demos/shop-page'), '/demos/shop-page') === out);

console.log('\nSERVING A PAGE STORED BEFORE ANY OF THIS EXISTED');

// The fix originally ran only at import, so a page already in the store kept its
// broken paths until a human re-imported it by hand. That is not a fix. Serving
// re-roots too, falling back to /demos/<slug> for records with no htmlSrc, which
// is where every one of them actually came from because the slug was derived
// from that path. This is the exact record that was live with a missing logo.
const stored = { slug: 'kcs-sports-academy-olathe', html: REAL, published: true, claimed: true, modules: ['P0'] };
const base = stored.htmlSrc || ('/demos/' + stored.slug);
const served = rerootRelativeUrls(stored.html, base);
check('an old record with no htmlSrc still gets its asset back on serve',
  served.includes('src="/demos/' + ASSET + '"'), (served.match(/src="[^"]*kcsa[^"]*"/) || [''])[0]);
check('and the broken path is gone from what gets served',
  !served.includes('src="' + ASSET + '"'));

// Serving runs on every request, so it must be safe to run over an already
// corrected page forever.
const twice = rerootRelativeUrls(served, base);
check('serving an already-corrected page a second time changes nothing', twice === served);
const thrice = rerootRelativeUrls(twice, base);
check('and a third time', thrice === served);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
