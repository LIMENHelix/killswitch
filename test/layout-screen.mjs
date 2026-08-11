// LAYOUT REGRESSION TEST: does any text run off its box, at any real screen size.
//
// Loads each surface in headless Chrome at four widths and fails on three faults,
// which are separate because they have separate fixes:
//   PAGE     the document scrolls sideways: something is wider than the screen
//   ESCAPES  an element box extends past the right edge of the viewport
//   CLIPPED  an element CONTENT is wider than its own box, so text is cut off
//
// It found real breakage on seven surfaces the first time it ran, the worst being
// a demo that dragged the whole page 368px sideways on a desktop because a
// visually hidden radio input had position:absolute with no offsets and no size.
//
// THE EXCLUSIONS ARE THE FRAGILE PART, so they are narrow and stated:
//   clip-path or width<=4px   deliberately hidden (honeypots, sr-only text)
//   no text content           decorative boxes whose art is a wider ::before
//   input/textarea/select     form controls scroll their own value by design
// A decorative element that escapes the VIEWPORT is still reported, so an
// oversized image cannot hide behind the no-text rule.
//
// Run: node test/layout-screen.mjs            (all covered surfaces)
//      node test/layout-screen.mjs index.html (one surface)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.join(import.meta.dirname, '..');
const WIDTHS = (process.env.KS_WIDTHS || "320,375,768,1440").split(",").map(Number);

const PAGES = process.argv[2] ? [process.argv[2]] : [
  // every hand-written page
  'index.html', 'pricing.html', 'services.html', 'work.html', 'switch.html',
  'contact.html', 'start.html', 'trades.html', 'terms.html', 'privacy.html',
  'panel.html', 'admin.html', 'master.html', 'switch-brain.html',
  // the programmatic pages, longest content first because they break first
  'free-website-for-cleaning-services-in-overland-park.html',
  'free-website-for-cleaning-services.html',
  'free-website-for-plumbers-in-kansas-city.html',
  // every demo, because these get handed out on live calls
  'demos/oouwees-barbershop-gladstone.html', 'demos/auto-tech-shawnee.html',
  'demos/amilcars-auto-repair-independence.html', 'demos/autobots-overland-park.html',
  'demos/charlies-brake-muffler-lenexa.html', 'demos/daves-trusted-auto-grandview.html',
  'demos/kcs-sports-academy-olathe.html', 'demos/lee-auto-repair-kansas-city.html',
  // and the product itself
  '__site__',
];

// The rendered customer site is a product surface too.
const { renderSite } = await import('../lib/site-template.js');
const { SITE_DEFAULT } = await import('../lib/sites.js');
const DEMO_SITE = {
  ...SITE_DEFAULT, slug: 'demo', business: "Gonzalez & Sons Automotive Repair Specialists",
  tagline: 'Brakes, transmissions, diagnostics and fleet servicing across the Kansas City metropolitan area.',
  phone: '816-555-0101', email_public: 'servicedesk@gonzalezandsonsautomotive.com',
  street: '11441 Shawnee Mission Parkway', city: 'Overland Park', state: 'KS', zip: '66203',
  services: [{ name: 'Transmission diagnostics', desc: 'Full computerised diagnostics' }, { name: 'Brakes' }],
  hours: [{ d: 'Monday to Friday', h: '8am to 6pm' }],
  about: 'A family business since 1978.',
  posts: [{ title: 'Winter servicing', body: 'Book early', date: 'Nov 1' }],
  modules: ['P0', 'P1', 'P2', 'P3', 'P7', 'P8', 'P9'], published: true, claimed: true,
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, entitled: false, modules: {}, leads: [], contacts: [], role: 'owner' }));
    return;
  }
  if (url === '/__site__') { res.setHeader('content-type', 'text/html'); res.end(renderSite(DEMO_SITE)); return; }
  let f = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!fs.existsSync(f) && fs.existsSync(f + '.html')) f += '.html';
  if (!fs.existsSync(f)) { res.statusCode = 404; res.end('nope'); return; }
  const ext = path.extname(f);
  res.setHeader('content-type', ext === '.css' ? 'text/css' : ext === '.js' ? 'application/javascript' : 'text/html');
  res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('Chrome not found'); process.exit(2); }

const userDir = path.join(process.env.TEMP, 'ks-overflow-' + PORT);
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--no-first-run',
  '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--user-data-dir=' + userDir, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });

const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  const t = setTimeout(() => reject(new Error('no debug port')), 20000);
  chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/ws:\/\/[^\s]+/); if (m) { clearTimeout(t); resolve(m[0]); } });
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const waiting = new Map(); let sessionId = null;
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
});
const send = (method, params = {}, sid = sessionId) => new Promise((res) => {
  const n = ++id; waiting.set(n, res);
  ws.send(JSON.stringify({ id: n, method, params, ...(sid ? { sessionId: sid } : {}) }));
});
const { result: t } = await send('Target.createTarget', { url: 'about:blank' }, null);
({ result: { sessionId } } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true }, null));
await send('Runtime.enable'); await send('Page.enable'); await send('Emulation.enable').catch(() => {});

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  return r.result && r.result.result ? r.result.result.value : null;
};

const PROBE = `(() => {
  const vw = window.innerWidth;
  const out = { pageScroll: document.documentElement.scrollWidth - vw, escapes: [], clipped: [] };
  const desc = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = (el.className && typeof el.className === 'string')
      ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : '';
    const txt = (el.textContent || '').trim().replace(/\\s+/g,' ').slice(0, 48);
    return el.tagName.toLowerCase() + id + cls + (txt ? ' "' + txt + '"' : '');
  };
  const seen = new Set();
  document.querySelectorAll('body *').forEach((el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;

    // Box pushed past the right edge (or off the left).
    if ((r.right > vw + 1 || r.left < -1) && cs.clipPath === 'none' && r.width > 4) {
      // Only report the OUTERMOST offender, otherwise every child is listed too.
      let p = el.parentElement, covered = false;
      while (p && p !== document.body) {
        const pr = p.getBoundingClientRect();
        if (pr.right > vw + 1 || pr.left < -1) { covered = true; break; }
        p = p.parentElement;
      }
      if (!covered) {
        const k = 'E' + desc(el);
        if (!seen.has(k)) { seen.add(k); out.escapes.push({ el: desc(el), right: Math.round(r.right), vw, over: Math.round(r.right - vw) }); }
      }
    }

    // Content wider than its own box, with no way to see the rest.
    // Three exclusions, all of them things that are not text running off:
    //  - deliberately hidden elements (honeypots, screen-reader-only text)
    //  - decorative boxes with no text at all, e.g. a lever whose crossbar is
    //    drawn by a ::before wider than its stem
    //  - form controls, which scroll their own value by design
    const over = el.scrollWidth - el.clientWidth;
    const hidden = el.clientWidth <= 4 || cs.clipPath !== 'none' || cs.opacity === '0';
    const decorative = !(el.textContent || '').trim();
    const control = /^(input|textarea|select)$/.test(el.tagName.toLowerCase());
    if (over > 1 && el.clientWidth > 0 && !hidden && !decorative && !control) {
      const ox = cs.overflowX;
      if (ox !== 'auto' && ox !== 'scroll') {
        const k = 'C' + desc(el);
        if (!seen.has(k)) { seen.add(k); out.clipped.push({ el: desc(el), over, overflowX: ox }); }
      }
    }
  });
  return out;
})()`;

const findings = [];
for (const page of PAGES) {
  const url = page === '__site__' ? `http://127.0.0.1:${PORT}/__site__` : `http://127.0.0.1:${PORT}/${page}`;
  for (const w of WIDTHS) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 700 });
    await send('Page.navigate', { url });
    await new Promise((r) => setTimeout(r, 550));
    const res = await evaluate(PROBE);
    if (!res) continue;
    if (res.pageScroll > 1 || res.escapes.length || res.clipped.length) {
      findings.push({ page, w, ...res });
    }
  }
}

console.log('\n================ OVERFLOW AUDIT ================\n');
let bad = 0;
const byPage = {};
for (const f of findings) (byPage[f.page] = byPage[f.page] || []).push(f);

for (const page of PAGES) {
  const fs2 = byPage[page];
  const label = page === '__site__' ? 'a rendered customer site (/s/<slug>)' : page;
  if (!fs2) { if (!process.env.KS_QUIET) console.log('  CLEAN   ' + label); continue; }
  bad++;
  console.log('  BROKEN  ' + label);
  for (const f of fs2) {
    const bits = [];
    if (f.pageScroll > 1) bits.push(`page scrolls sideways by ${f.pageScroll}px`);
    console.log(`      @${f.w}px  ${bits.join(', ') || 'contained, but:'}`);
    f.escapes.slice(0, 6).forEach((e) => console.log(`          ESCAPES +${e.over}px  ${e.el}`));
    f.clipped.slice(0, 6).forEach((c) => console.log(`          CLIPPED +${c.over}px  [overflow-x:${c.overflowX}]  ${c.el}`));
  }
  console.log('');
}
console.log(`\n${bad} of ${PAGES.length} surfaces have a problem\n`);
try { chrome.kill(); } catch {}
server.close();
process.exit(bad ? 1 : 0);
