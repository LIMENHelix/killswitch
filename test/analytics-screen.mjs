// Does the conversion tracking actually fire, in a real browser.
//
// Vercel Web Analytics counted VISITS only, so the dashboard could say 56 people
// arrived and nothing about whether any of them did anything. These events are
// the answer to that, and they are only worth having if they genuinely fire at
// the moment of conversion, so this drives the real pages and captures what gets
// pushed onto the analytics queue.
//
// The queue (window.vaq) is where events land before Vercel's own script drains
// them, so intercepting it needs no network and no real analytics account.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'C:/Users/Chris/killswitch';
let web3 = 0, checkout = 0;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  // Stand in for Web3Forms so a form can succeed without leaving the machine.
  if (url === '/w3f') { web3++; res.setHeader('content-type', 'application/json'); res.end('{"success":true}'); return; }
  if (url === '/api/checkout') {
    checkout++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ url: 'http://127.0.0.1:' + PORT + '/landed.html' }));
    return;
  }
  if (url === '/landed.html') { res.setHeader('content-type', 'text/html'); res.end('<title>landed</title>ok'); return; }
  if (url.startsWith('/api/')) { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); return; }
  if (url === '/_vercel/insights/script.js') { res.setHeader('content-type', 'application/javascript'); res.end(''); return; }
  const f = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!fs.existsSync(f)) { res.statusCode = 404; res.end('no'); return; }
  const ext = path.extname(f);
  res.setHeader('content-type', ext === '.css' ? 'text/css' : ext === '.js' ? 'application/javascript' : 'text/html');
  // Point the real form code at the local stand-in instead of Web3Forms.
  let body = fs.readFileSync(f, 'utf8');
  if (ext === '.html' || ext === '.js') body = body.split('https://api.web3forms.com/submit').join('/w3f');
  res.end(body);
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('Chrome not found, cannot run the DOM check'); process.exit(2); }
const userDir = path.join(process.env.TEMP, 'ks-analytics-' + PORT);
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--no-first-run',
  '--no-default-browser-check', '--disable-gpu', '--user-data-dir=' + userDir, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let buf = ''; const t = setTimeout(() => reject(new Error('no debug port')), 20000);
  chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/ws:\/\/[^\s]+/); if (m) { clearTimeout(t); resolve(m[0]); } });
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const waiting = new Map(); const errors = []; let sessionId = null;
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text + ' ' + ((m.params.exceptionDetails.exception||{}).description||''));
});
const send = (method, params = {}, sid = sessionId) => new Promise((res) => {
  const n = ++id; waiting.set(n, res);
  ws.send(JSON.stringify({ id: n, method, params, ...(sid ? { sessionId: sid } : {}) }));
});
const { result: t } = await send('Target.createTarget', { url: 'about:blank' }, null);
({ result: { sessionId } } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true }, null));
await send('Runtime.enable'); await send('Page.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  (function(){
    var K='__ksev';
    window.va = function(){
      try {
        if (arguments[0] === 'event') {
          var a = JSON.parse(sessionStorage.getItem(K) || '[]');
          a.push(arguments[1]);
          sessionStorage.setItem(K, JSON.stringify(a));
        }
      } catch (e) {}
    };
  })();
` });
const evaluate = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: false }); return r.result && r.result.result ? r.result.result.value : null; };

// Everything pushed to the queue, by name.
const REC = `JSON.parse(sessionStorage.getItem('__ksev')||'[]')`;
const NAMES = `${REC}.map(e=>e.name)`;
const EVENT = (n) => `JSON.stringify((${REC}.find(e=>e.name===${JSON.stringify(n)})||{}).data||null)`;

async function open(p) {
  errors.length = 0;
  // Cleared BEFORE navigating, so events fired during page load are kept.
  await send('Runtime.evaluate', { expression: `try{sessionStorage.removeItem('__ksev')}catch(e){}` });
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}${p}` });
  await new Promise((r) => setTimeout(r, 700));
}

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };

console.log('\nNOTHING FIRES FOR A DRIVE-BY, which is what makes the numbers mean something');
await open('/');
check('no javascript errors', errors.length === 0, errors.join(' | '));
check('the tracker loaded', (await evaluate(`typeof window.ksEvent`)) === 'function');
check('a page load alone is NOT counted as a human',
  !(await evaluate(NAMES)).includes('human_visit'), JSON.stringify(await evaluate(NAMES)));

console.log('\nA REAL PERSON IS COUNTED, on any one of the signals');
await evaluate(`document.dispatchEvent(new MouseEvent('mousemove',{clientX:10,clientY:10}));
                document.dispatchEvent(new MouseEvent('mousemove',{clientX:90,clientY:70}));`);
await new Promise((r) => setTimeout(r, 200));
check('a pointer that actually moves counts', (await evaluate(NAMES)).includes('human_visit'));
check('and it says which signal proved it',
  JSON.parse(await evaluate(EVENT('human_visit')) || '{}').signal === 'pointer', await evaluate(EVENT('human_visit')));
check('it fires ONCE, not on every twitch',
  (await evaluate(NAMES)).filter((n) => n === 'human_visit').length === 1);

// A synthetic event that never moves is what a crawler produces.
await open('/');
await evaluate(`document.dispatchEvent(new MouseEvent('mousemove',{clientX:0,clientY:0}));
                document.dispatchEvent(new MouseEvent('mousemove',{clientX:0,clientY:0}));`);
await new Promise((r) => setTimeout(r, 200));
check('a pointer that never moves does NOT count',
  !(await evaluate(NAMES)).includes('human_visit'), JSON.stringify(await evaluate(NAMES)));

console.log('\nTHE CONVERSIONS');
await open('/');
const before = web3;
await evaluate(`
  document.getElementById('fBiz').value = 'Test Plumbing';
  document.getElementById('fPhone').value = '816-555-0101';
  document.getElementById('fEmail').value = 'test@example.com';
  document.getElementById('capForm').requestSubmit();
`);
await new Promise((r) => setTimeout(r, 900));
check('the homepage form still actually submits', web3 === before + 1, `${before} -> ${web3}`);
check('and a signup is recorded', (await evaluate(NAMES)).includes('signup_submitted'), JSON.stringify(await evaluate(NAMES)));
check('tagged with where it came from',
  JSON.parse(await evaluate(EVENT('signup_submitted')) || 'null')?.source === 'homepage', await evaluate(EVENT('signup_submitted')));

await open('/');
await evaluate(`document.querySelector('a[href^="tel:"]').click()`);
await new Promise((r) => setTimeout(r, 250));
check('tapping the phone number is recorded, the highest-intent act on the site',
  (await evaluate(NAMES)).includes('call_clicked'), JSON.stringify(await evaluate(NAMES)));

await open('/pricing.html');
const cbefore = checkout;
await evaluate(`document.querySelector('.path__cb[data-phase="P1"]').click()`);
await new Promise((r) => setTimeout(r, 200));
await evaluate(`document.getElementById('ladderEmail').value = 'buyer@example.com'`);
await evaluate(`document.getElementById('ladderCheckout').click()`);
await new Promise((r) => setTimeout(r, 900));
check('checkout still reaches the server', checkout === cbefore + 1, `${cbefore} -> ${checkout}`);
check('and reaching Stripe is recorded, surviving the redirect', (await evaluate(NAMES)).includes('checkout_started'),
  JSON.stringify(await evaluate(NAMES)));
check('with what they were buying',
  ((JSON.parse(await evaluate(EVENT('checkout_started')) || 'null')||{}).modules || '').includes('P1'),
  await evaluate(EVENT('checkout_started')));

await open('/demos/auto-tech-shawnee.html');
check('opening a demo is recorded, since the only way there is a postcard or a call',
  (await evaluate(NAMES)).includes('demo_viewed'), JSON.stringify(await evaluate(NAMES)));

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
try { chrome.kill(); } catch {}
server.close();
process.exit(fail ? 1 : 0);
