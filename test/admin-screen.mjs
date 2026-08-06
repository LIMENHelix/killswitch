// Loads the real admin.html in headless Chrome against a stubbed /api/admin and
// checks it actually renders, for BOTH roles. Catches the reference errors that
// node --check cannot see. Zero dependencies, CDP over the raw websocket.
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const ADMIN = 'C:/Users/Chris/killswitch/admin.html';
const LEADS = [
  { id: 'L1', name: 'Auto Tech Services Center', trade: 'auto repair', phone: '913-268-7887', street: '11441 Shawnee Mission Pkwy', city: 'Shawnee', state: 'KS', zip: '66203', stage: 'called', owner: 'dana' },
  { id: 'L2', name: 'Autobots Garage', trade: 'auto repair', phone: '913-722-5151', street: '5000 Mackey St', city: 'Overland Park', state: 'KS', zip: '66203' },
  { id: 'L3', name: 'Some Random Salon', trade: 'hair salon', phone: '816-555-0000', street: '9 X St', city: 'Kansas City', state: 'MO', zip: '64109', status: 'mailed' },
];

let ROLE = 'owner';
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/admin')) {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      res.setHeader('content-type', 'application/json');
      if (body.action === 'list') return res.end(JSON.stringify({ ok: true, leads: LEADS, role: ROLE, name: ROLE === 'rep' ? 'dana' : 'operator' }));
      if (body.action === 'config') return res.end(JSON.stringify({ ok: true, config: { enabled: false, dailyCap: 0, budgetCeiling: 0 } }));
      if (body.action === 'update') return res.end(JSON.stringify({ ok: true, meta: { stage: body.stage, owner: 'dana' } }));
      res.end(JSON.stringify({ ok: false, error: 'nope' }));
    });
    return;
  }
  res.setHeader('content-type', 'text/html');
  res.end(fs.readFileSync(ADMIN));
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('Chrome not found, cannot run the DOM check'); process.exit(2); }

const userDir = path.join(process.env.TEMP, 'ks-cdp-' + PORT);
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

const { WebSocket } = await import('node:http').then(() => ({ WebSocket: globalThis.WebSocket }));
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

async function load(role) {
  ROLE = role; consoleErrors.length = 0;
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/admin` });
  await new Promise((r) => setTimeout(r, 1200));
  await send('Runtime.evaluate', { expression: `localStorage.setItem('ks-admin-key','k'); location.reload();` });
  await new Promise((r) => setTimeout(r, 1500));
}
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  return r.result.result.value;
};

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };

console.log('\nOWNER view');
await load('owner');
check('no javascript errors', consoleErrors.length === 0, consoleErrors.join(' | '));
check('app is showing', await evaluate(`getComputedStyle(document.getElementById('app')).display !== 'none'`));
check('all 3 leads rendered', await evaluate(`document.querySelectorAll('#tb tr').length`) === 3);
check('autopilot panel is visible', await evaluate(`!document.getElementById('autopanel').hidden`));
check('mail bar is visible', await evaluate(`!document.getElementById('mailbar').hidden`));
check('badge says Owner', (await evaluate(`document.getElementById('whoami').textContent`)) === 'Owner');
check('owner column shows the rep who worked L1', (await evaluate(`document.querySelector('#tb tr td.owner-c').textContent`)) === 'dana');

console.log('\nREP view');
await load('rep');
check('no javascript errors', consoleErrors.length === 0, consoleErrors.join(' | '));
check('autopilot panel is HIDDEN', await evaluate(`document.getElementById('autopanel').hidden === true`));
check('mail bar is HIDDEN', await evaluate(`document.getElementById('mailbar').hidden === true`));
check('spend to date is HIDDEN', await evaluate(`document.getElementById('spendWrap').hidden === true`));
check('badge names the rep', (await evaluate(`document.getElementById('whoami').textContent`)) === 'Rep · dana');
check('title is the call list', (await evaluate(`document.getElementById('pageTitle').textContent`)) === 'Call list');
check('no mail checkbox column in rows', await evaluate(`!document.querySelector('#tb .rc')`));

console.log('\nCALL SCRIPT');
check('a shop with a demo offers Script + demo', (await evaluate(
  `[...document.querySelectorAll('#tb tr')].find(r=>r.textContent.includes('Auto Tech')).querySelector('.scriptbtn').textContent`)) === 'Script + demo');
check('a shop without one offers plain Script', (await evaluate(
  `[...document.querySelectorAll('#tb tr')].find(r=>r.textContent.includes('Random Salon')).querySelector('.scriptbtn').textContent`)) === 'Script');

await evaluate(`[...document.querySelectorAll('#tb tr')].find(r=>r.textContent.includes('Auto Tech')).querySelector('.scriptbtn').click()`);
await new Promise((r) => setTimeout(r, 250));
check('the modal opens', await evaluate(`document.getElementById('scriptModal').classList.contains('open')`));
check('it names the owner from the strike list', (await evaluate(`document.getElementById('scSteps').textContent`)).includes('is this Kendall'));
check('it uses their real hook', (await evaluate(`document.getElementById('scSteps').textContent`)).includes('best reputation in Shawnee'));
check('it links the live demo', (await evaluate(`document.getElementById('scWarn').innerHTML`)).includes('/demos/auto-tech-shawnee'));
check('it says delivery, not pitch', (await evaluate(`document.getElementById('scWarn').className`)).includes('ok'));
check('follow-up text is ready to copy', await evaluate(`document.getElementById('scCopyText').disabled === false`));

await evaluate(`document.getElementById('scClose').click()`);
await evaluate(`[...document.querySelectorAll('#tb tr')].find(r=>r.textContent.includes('Random Salon')).querySelector('.scriptbtn').click()`);
await new Promise((r) => setTimeout(r, 250));
const warn = await evaluate(`document.getElementById('scWarn').textContent`);
check('no demo means it WARNS instead of lying', warn.includes('No site has been built'), warn.slice(0, 80));
check('and it does not offer a text with no link', await evaluate(`document.getElementById('scCopyText').disabled === true`));
check('step 3 stops promising a built site', !(await evaluate(`document.getElementById('scSteps').textContent`)).includes('already built you a real website'));

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
chrome.kill(); server.close();
process.exit(fail ? 1 : 0);
