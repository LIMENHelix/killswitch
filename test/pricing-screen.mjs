// Loads the real pricing.html in headless Chrome against a stubbed /api/checkout.
// This is the money page and its checkout logic is inline, so node --check sees
// none of it. Two things are worth a browser here:
//
//   every module on the board is one that exists, and the copy stays narrow
//   the email gate fires before a card is ever asked for
//
// Standalone with its own CDP driver, matching admin-screen.mjs and
// master-screen.mjs rather than inventing a shared harness for a third caller.
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

// Repo root, derived from this file's own location so the suite runs
// from any checkout rather than only from C:/Users/Chris/killswitch.
const ROOT = path.join(import.meta.dirname, '..');

const PRICING = path.join(ROOT, 'pricing.html');
let posted = null;

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/checkout')) {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      posted = JSON.parse(b || '{}');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ url: 'https://checkout.stripe.com/pay/cs_test_stub' }));
    });
    return;
  }
  if (req.url.endsWith('.css')) {
    res.setHeader('content-type', 'text/css');
    res.end(fs.existsSync(path.join(ROOT, 'ks.css')) ? fs.readFileSync(path.join(ROOT, 'ks.css')) : '');
    return;
  }
  if (req.url.endsWith('.js')) { res.setHeader('content-type', 'application/javascript'); res.end(''); return; }
  res.setHeader('content-type', 'text/html');
  res.end(fs.readFileSync(PRICING));
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('Chrome not found, cannot run the DOM check'); process.exit(2); }

const userDir = path.join(os.tmpdir(), 'ks-pricing-cdp-' + PORT);
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--no-first-run',
  '--no-default-browser-check', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--user-data-dir=' + userDir, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });

const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  const t = setTimeout(() => reject(new Error('chrome did not report a debug port')), 20000);
  chrome.stderr.on('data', (d) => {
    buf += d;
    const m = buf.match(/ws:\/\/[^\s]+/);
    if (m) { clearTimeout(t); resolve(m[0]); }
  });
});

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const waiting = new Map(); const consoleErrors = []; let sessionId = null;
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || ''));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(m.params.args.map((a) => a.value || a.description).join(' '));
});
const send = (method, params = {}, sid = sessionId) => new Promise((res) => {
  const n = ++id; waiting.set(n, res);
  ws.send(JSON.stringify({ id: n, method, params, ...(sid ? { sessionId: sid } : {}) }));
});

const { result: t } = await send('Target.createTarget', { url: 'about:blank' }, null);
({ result: { sessionId } } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true }, null));
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/pricing` });
await new Promise((r) => setTimeout(r, 1400));

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false });
  return r.result.result.value;
};

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };

console.log('\nTHE BOARD only offers what exists, and describes it narrowly');
check('no javascript errors', consoleErrors.length === 0, consoleErrors.join(' | '));
const sold = await evaluate(`[...document.querySelectorAll('.path__cb')].map(c=>c.getAttribute('data-phase'))`);
check('the rungs render', Array.isArray(sold) && sold.length > 0, JSON.stringify(sold));
check('every module that exists is purchasable, CRM and automation included',
  ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9'].every((p) => sold.includes(p)), JSON.stringify(sold));
// CRM and automation are narrower than their names suggest, and the page has to
// say so rather than let a buyer imagine a Salesforce.
const copy = await evaluate(`document.querySelector('#path').textContent`);
check('CRM is sold as the list it is', copy.includes('kept as a person, not an email'));
check('and does not claim to import from anywhere else', !/import/i.test(copy));
check('automation names its two messages', copy.includes('thank-you') && copy.includes('review request'));
check('and rules out texts, which we do not send', copy.includes('We do not send automated texts'));
// EVERY rung that can be bought has a one-click Buy now, because that is the
// path a non-technical owner actually takes. Removing two of them left the page
// inconsistent for no benefit: the links were never disabled in Stripe, only
// hidden, so hiding them cost a conversion path and prevented nothing.
// 12 Stripe links: 9 monthly Buy now, plus the 3 one-time alternatives on the
// build-once modules (booking, CRM, payments). P0 and P10 also use .path__buy
// but point at Calendly, which is why the class count is 11 and not 9.
const stripeLinks = await evaluate(`(document.body.innerHTML.match(/buy\.stripe\.com/g)||[]).length`);
check('all 12 Stripe buy links are on the page', stripeLinks === 12, String(stripeLinks));
check('every rung that takes money offers one click',
  (await evaluate(`[...document.querySelectorAll('.path__buy')].length`)) === 11);
check('CRM can be bought in one click again',
  await evaluate(`document.body.innerHTML.includes('1ck09')`));
check('and so can automation',
  await evaluate(`document.body.innerHTML.includes('1ck0a')`));

console.log('\nTHE EMAIL GATE fires before any card is asked for');
await evaluate(`document.querySelector('.path__cb[data-phase="P1"]').click()`);
await new Promise((r) => setTimeout(r, 150));
await evaluate(`document.getElementById('ladderCheckout').click()`);
await new Promise((r) => setTimeout(r, 400));
check('checking out with no email does not reach the server', posted === null, JSON.stringify(posted));
check('and it says why', (await evaluate(`document.getElementById('ladderNote').textContent`)).toLowerCase().includes('email'),
  await evaluate(`document.getElementById('ladderNote').textContent`));

await evaluate(`document.getElementById('ladderEmail').value='buyer@example.com'`);
await evaluate(`document.getElementById('ladderCheckout').click()`);
await new Promise((r) => setTimeout(r, 500));
check('with an email it goes through', posted !== null, 'never posted');
check('and the email travels with the basket', posted && posted.email === 'buyer@example.com', JSON.stringify(posted));
check('along with what they ticked', posted && posted.phases.includes('P1'), JSON.stringify(posted));

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
try { chrome.kill(); } catch { /* already gone */ }
server.close();
process.exit(fail ? 1 : 0);
