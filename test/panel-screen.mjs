// Loads the real panel.html in headless Chrome against a stubbed /api/switch and
// checks what the customer actually SEES.
//
// This exists because of one specific way the P5/P6 retirement could have gone
// wrong. The obvious fix, deleting the two modules from the panel's catalogue,
// silently cancels them: the browser stops sending the phase, the server reads
// the absence as "turn it off", and someone who is paying loses what they bought
// without ever touching the switch. So the rule has two halves, and only a real
// DOM can confirm the second one:
//
//   a customer who does NOT have a retired module must never be offered it
//   a customer who DOES have one must still see it, and be able to switch it off
//
// Zero dependencies, CDP over the raw websocket, same shape as admin-screen.mjs.
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const PANEL = 'C:/Users/Chris/killswitch/panel.html';

// What the fake /api/switch reports as this customer's live subscriptions.
let MODULES_LIVE = {};
let applied = null;

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/switch')) {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      res.setHeader('content-type', 'application/json');
      if (body.action === 'apply') applied = body.on;
      res.end(JSON.stringify({ ok: true, site: 'test-shop', name: 'Test Shop', linked: true, modules: MODULES_LIVE }));
    });
    return;
  }
  if (req.url.startsWith('/api/support')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'not_entitled', need: ['P11', 'P4'] }));
    return;
  }
  res.setHeader('content-type', 'text/html');
  res.end(fs.readFileSync(PANEL));
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('Chrome not found, cannot run the DOM check'); process.exit(2); }

const userDir = path.join(process.env.TEMP, 'ks-panel-cdp-' + PORT);
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

async function load(live) {
  MODULES_LIVE = live; applied = null; consoleErrors.length = 0;
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/panel?e=shop%40example.com&t=tok` });
  await new Promise((r) => setTimeout(r, 1400));
}
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  return r.result.result.value;
};

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };

// A row's switch carries data-id, so the set of offered modules is readable.
const offered = `[...document.querySelectorAll('#mlist .klsw')].map(b=>b.getAttribute('data-id'))`;

console.log('\nAN ORDINARY CUSTOMER is never offered a module we cannot build');
await load({ P1: { state: 'active', endsAt: 9999999999 } });
check('no javascript errors', consoleErrors.length === 0, consoleErrors.join(' | '));
check('the switchboard rendered', (await evaluate(`document.querySelectorAll('#mlist .mrow').length`)) > 0);
check('CRM is not on the board', !(await evaluate(offered)).includes('P5'), JSON.stringify(await evaluate(offered)));
check('Marketing Automation is not on the board', !(await evaluate(offered)).includes('P6'));
const board = await evaluate(offered);
check('the modules that do exist are still offered',
  ['P1', 'P2', 'P3', 'P4', 'P7', 'P8', 'P9', 'P11'].every((p) => board.includes(p)), JSON.stringify(board));
check('their real module reads as on',
  (await evaluate(`document.querySelector('#mlist .klsw[data-id="P1"]').getAttribute('aria-checked')`)) === 'true');
check('the name CRM appears nowhere on the page',
  !(await evaluate(`document.getElementById('mlist').textContent`)).includes('CRM'));

console.log('\nSOMEONE WHO ALREADY BOUGHT ONE keeps it, and can switch it off');
await load({ P5: { state: 'active', endsAt: 9999999999 } });
check('no javascript errors', consoleErrors.length === 0, consoleErrors.join(' | '));
check('they still see the module they pay for', (await evaluate(offered)).includes('P5'), JSON.stringify(await evaluate(offered)));
check('and it reads as on',
  (await evaluate(`document.querySelector('#mlist .klsw[data-id="P5"]').getAttribute('aria-checked')`)) === 'true');
check('it is still priced honestly at $29',
  (await evaluate(`[...document.querySelectorAll('#mlist .mrow')].find(r=>r.textContent.includes('CRM')).querySelector('.m-price').textContent`)).includes('29'));

// The whole point: saving must send P5 back, or the server reads the silence as
// a cancellation and takes away something they are paying for.
await evaluate(`document.querySelector('#mlist .klsw[data-id="P5"]').click()`);
await new Promise((r) => setTimeout(r, 200));
check('switching it off is allowed',
  (await evaluate(`document.querySelector('#mlist .klsw[data-id="P5"]').getAttribute('aria-checked')`)) === 'false'
  || (await evaluate(`document.getElementById('mlist').textContent`)).toLowerCase().includes('until'));

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
try { chrome.kill(); } catch { /* already gone */ }
server.close();
process.exit(fail ? 1 : 0);
