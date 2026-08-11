// Loads a REAL rendered customer site in headless Chrome. This is the product,
// and until now nothing loaded it in a browser: renderSite was only ever checked
// as a string, so any JavaScript in it was unverified.
//
// The specific thing worth proving here is the free contact form, because its
// handler reads f.name / f.contact / f.message off the form element. That looks
// like it should collide with HTMLFormElement's own `name` property, and the
// only honest way to know it resolves to the input is to run it in a browser.
//
// Two sites are loaded: a FREE one (contact form only) and a fully paid one
// (booking and the AI widget as well), so the module gating is checked against a
// live DOM rather than a substring search.
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const { renderSite } = await import('../lib/site-template.js');
const { SITE_DEFAULT } = await import('../lib/sites.js');

const BASE = {
  ...SITE_DEFAULT, slug: 'free-shop', business: "Jo's Garage", phone: '816-555-0101',
  tagline: 'Brakes, tyres and diagnostics in Kansas City.',
  city: 'Kansas City', state: 'MO', street: '9 Elm St',
  services: [{ name: 'Brakes', desc: 'Pads and discs' }, { name: 'Diagnostics' }],
  hours: [{ d: 'Mon to Fri', h: '8am to 6pm' }],
  published: true, claimed: true,
};
const FREE = { ...BASE, modules: ['P0'] };
const PAID = { ...BASE, modules: ['P0', 'P1', 'P3', 'P7', 'P8', 'P9'] };

let which = FREE;
let posted = null;

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/site-action')) {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      posted = JSON.parse(b || '{}');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  if (req.url.startsWith('/_vercel')) { res.setHeader('content-type', 'application/javascript'); res.end(''); return; }
  res.setHeader('content-type', 'text/html');
  res.end(renderSite(which));
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('Chrome not found, cannot run the DOM check'); process.exit(2); }

const userDir = path.join(process.env.TEMP, 'ks-site-cdp-' + PORT);
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--no-first-run',
  '--no-default-browser-check', '--disable-gpu', '--user-data-dir=' + userDir, 'about:blank'],
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

async function load(site) {
  which = site; posted = null; consoleErrors.length = 0;
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/s/free-shop` });
  await new Promise((r) => setTimeout(r, 900));
}
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  return r.result.result.value;
};

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };

console.log('\nA FREE SITE can be contacted, and gets nothing it has not paid for');
await load(FREE);
check('no javascript errors', consoleErrors.length === 0, consoleErrors.join(' | '));
check('the business name is the heading', (await evaluate(`document.querySelector('h1').textContent`)) === "Jo's Garage");
check('the contact form is on the page', await evaluate(`!!document.querySelector('form.cf')`));
check('the phone number is tap-to-call', await evaluate(`!!document.querySelector('a[href^="tel:+1"]')`));
check('no booking section', await evaluate(`!document.getElementById('book')`));
check('no AI widget', await evaluate(`!document.getElementById('aiBtn')`));
check('no pay section', await evaluate(`!document.getElementById('pay')`));

// The point of the whole exercise: does submitting it actually send anything?
await evaluate(`
  var f=document.querySelector('form.cf');
  f.querySelector('[name=name]').value='Dana';
  f.querySelector('[name=contact]').value='816-555-7777';
  f.querySelector('[name=message]').value='Do you do brakes on a Tuesday?';
  f.requestSubmit ? f.requestSubmit() : f.querySelector('button').click();
`);
await new Promise((r) => setTimeout(r, 500));
check('submitting it reaches the server', posted !== null, 'nothing was posted');
check('it is a contact action for this site', posted && posted.action === 'contact' && posted.slug === 'free-shop', JSON.stringify(posted));
// This is the assertion the file exists for. If `f.name` resolved to the form's
// own name property instead of the input, this would be undefined.
check('the visitor NAME survives the form-property collision', posted && posted.name === 'Dana', JSON.stringify(posted));
check('and so does the rest', posted && posted.contact === '816-555-7777' && posted.message.includes('brakes'), JSON.stringify(posted));
check('the honeypot rides along empty', posted && posted.website === '', JSON.stringify(posted && posted.website));
check('the visitor is told it sent', (await evaluate(`document.getElementById('cfMsg').textContent`)).toLowerCase().includes('thanks'),
  await evaluate(`document.getElementById('cfMsg').textContent`));

console.log('\nA PAID SITE gets what it pays for, contact form included');
await load(PAID);
check('no javascript errors', consoleErrors.length === 0, consoleErrors.join(' | '));
check('booking is there', await evaluate(`!!document.getElementById('book')`));
check('the AI widget is there', await evaluate(`!!document.getElementById('aiBtn')`));
check('pay online is there', await evaluate(`!!document.getElementById('pay')`));
check('the free contact form is STILL there', await evaluate(`!!document.querySelector('form.cf')`));
check('the search listing markup is present', await evaluate(`!!document.querySelector('script[type="application/ld+json"]')`));

await evaluate(`document.getElementById('aiBtn').click()`);
await new Promise((r) => setTimeout(r, 200));
check('the AI panel opens', await evaluate(`document.getElementById('aiP').classList.contains('open')`));

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
try { chrome.kill(); } catch { /* already gone */ }
server.close();
process.exit(fail ? 1 : 0);
