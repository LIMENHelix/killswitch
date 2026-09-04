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
import os from 'node:os';

// Repo root, derived from this file's own location so the suite runs
// from any checkout rather than only from C:/Users/Chris/killswitch.
const ROOT = path.join(import.meta.dirname, '..');

const PANEL = path.join(ROOT, 'panel.html');

// What the fake /api/switch reports as this customer's live subscriptions.
let MODULES_LIVE = {};
let applied = null;
let STATS = { entitled: false };
let CRM = { entitled: false };
let DENY = false;   // make the stubbed /api/switch answer 'unauthorized'

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/switch')) {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      res.setHeader('content-type', 'application/json');
      if (DENY) { res.end(JSON.stringify({ error: 'unauthorized' })); return; }
      if (body.action === 'stats') { res.end(JSON.stringify(STATS)); return; }
      if (body.action === 'crm') { res.end(JSON.stringify(CRM)); return; }
      if (body.action === 'crm-update') { res.end(JSON.stringify({ ok: true })); return; }
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
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('Chrome not found, cannot run the DOM check'); process.exit(2); }

const userDir = path.join(os.tmpdir(), 'ks-panel-cdp-' + PORT);
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

async function load(live, stats = { entitled: false }, crm = { entitled: false }, deny = false) {
  MODULES_LIVE = live; applied = null; STATS = stats; CRM = crm; DENY = deny; consoleErrors.length = 0;
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

console.log('\nTHE BOARD offers every module that exists');
await load({ P1: { state: 'active', endsAt: 9999999999 } });
check('no javascript errors', consoleErrors.length === 0, consoleErrors.join(' | '));
check('the switchboard rendered', (await evaluate(`document.querySelectorAll('#mlist .mrow').length`)) > 0);
const board = await evaluate(offered);
check('every built module is offered, CRM and automation included',
  ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P11'].every((p) => board.includes(p)), JSON.stringify(board));
check('their real module reads as on',
  (await evaluate(`document.querySelector('#mlist .klsw[data-id="P1"]').getAttribute('aria-checked')`)) === 'true');
check('CRM is described as the list it actually is, not a pipeline',
  (await evaluate(`document.getElementById('mlist').textContent`)).includes('kept as a customer list'));

// THE RETIRE PATH IS NOT DRIVEN FROM HERE, deliberately. RETIRED is empty, so
// no real module is hidden, and MODULES lives inside the page's IIFE where a
// test cannot reach it to fake one. An earlier version of this file mutated it
// anyway; the mutation silently did nothing and the assertion passed for the
// wrong reason, which is worse than no test. The gate itself is covered
// server-side in test/api.mjs section 11. All that is checked here is that the
// filter the gate depends on is still wired into render().
const panelSrc = fs.readFileSync(PANEL, 'utf8');
check('render() still drops a retired module that is off',
  /filter\(function\(m\)\{ return !m\.retired \|\| m\.state!==.off.; \}\)/.test(panelSrc),
  'the retire filter is gone from render()');

console.log('\nP8 VISITOR NUMBERS, the module they could not see before');
await load({ P1: { state: 'active', endsAt: 9999999999 } });
check('someone not paying for it sees no stats section',
  await evaluate(`document.getElementById('statsWrap').hidden === true`));

const series = Array.from({ length: 30 }, (_, i) => ({ date: '2026-07-' + String(i + 1).padStart(2, '0'), views: i }));
await load({ P8: { state: 'active', endsAt: 9999999999 } },
  { entitled: true, slug: 'test-shop', stats: { allTime: 1234, thisMonth: 87, lastMonth: 42, last30: 435, series } });
check('no javascript errors', consoleErrors.length === 0, consoleErrors.join(' | '));
check('a paying customer sees the section', await evaluate(`document.getElementById('statsWrap').hidden === false`));
check('this month is their real number', (await evaluate(`document.getElementById('stMonth').textContent`)) === '87');
check('last month is shown beside it', (await evaluate(`document.getElementById('stLast').textContent`)) === '42');
check('all time is formatted for a human', (await evaluate(`document.getElementById('stAll').textContent`)) === '1,234');
check('the 30 day chart is drawn', (await evaluate(`document.querySelectorAll('#stSpark i').length`)) === 30);

// Three zeros with no explanation reads as broken, so it says so in words.
await load({ P8: { state: 'active', endsAt: 9999999999 } },
  { entitled: true, slug: 'test-shop', stats: { allTime: 0, thisMonth: 0, lastMonth: 0, last30: 0, series: series.map((s) => ({ ...s, views: 0 })) } });
check('a site with no visitors yet says so in words',
  (await evaluate(`document.getElementById('stNote').textContent`)).toLowerCase().includes('nobody has opened'),
  await evaluate(`document.getElementById('stNote').textContent`));


console.log('\nP5 CUSTOMER LIST, the module that used to be a price with nothing behind it');
await load({ P1: { state: 'active', endsAt: 9999999999 } });
check('someone not paying for it sees no customer list',
  await evaluate(`document.getElementById('crmWrap').hidden === true`));

const CONTACTS = [
  { id: 'dana@example.com', name: 'Dana Reed', email: 'dana@example.com', phone: '', status: 'new',
    createdAt: '2026-06-01T10:00:00Z', updatedAt: '2026-06-02T10:00:00Z',
    entries: [{ at: '2026-06-01T10:00:00Z', kind: 'message', text: 'Do you do brakes?' },
              { at: '2026-06-02T10:00:00Z', kind: 'booking', text: 'Tuesday 9am' }] },
  { id: '8165552222', name: 'Sam Okafor', email: '', phone: '816-555-2222', status: 'won',
    createdAt: '2026-05-20T10:00:00Z', updatedAt: '2026-05-20T10:00:00Z',
    entries: [{ at: '2026-05-20T10:00:00Z', kind: 'message', text: 'Quote for a full service please' }] },
];

await load({ P5: { state: 'active', endsAt: 9999999999 } }, { entitled: false },
  { entitled: true, slug: 'test-shop', contacts: CONTACTS,
    summary: { total: 2, new: 1, contacted: 0, won: 1, lost: 0 },
    automation: { pending: 3, sent: 11 } });

check('no javascript errors', consoleErrors.length === 0, consoleErrors.join(' | '));
check('a paying customer sees their list', await evaluate(`document.getElementById('crmWrap').hidden === false`));
check('both people are shown', (await evaluate(`document.querySelectorAll('#crmList .crow').length`)) === 2);
check('the headline counts are their real numbers',
  (await evaluate(`document.getElementById('crmTotal').textContent`)) === '2'
  && (await evaluate(`document.getElementById('crmNew').textContent`)) === '1'
  && (await evaluate(`document.getElementById('crmWon').textContent`)) === '1');
check('the last thing someone said is on the row',
  (await evaluate(`document.getElementById('crmList').textContent`)).includes('Tuesday 9am'));
check('a booking reads as a booking, not a message',
  (await evaluate(`document.getElementById('crmList').textContent`)).includes('Asked to book'));
check('the message count shows the history is kept',
  (await evaluate(`document.getElementById('crmList').textContent`)).includes('2 messages'));
check('someone who left an email gets a mailto link',
  await evaluate(`!!document.querySelector('#crmList a[href^="mailto:dana@example.com"]')`));
check('someone who left a phone gets tap to call',
  await evaluate(`!!document.querySelector('#crmList a[href^="tel:"]')`));
check('their status is on the row', (await evaluate(`document.querySelector('#crmList .cst').textContent`)) === 'new');

// P6 rides along on the same screen.
check('the follow-up queue is shown beside the people',
  (await evaluate(`document.getElementById('autoStat').hidden === false`))
  && (await evaluate(`document.getElementById('crmQueued').textContent`)) === '3'
  && (await evaluate(`document.getElementById('crmSent').textContent`)) === '11');

// Marking someone off is the one thing the owner does here, so it has to work.
await evaluate(`document.querySelector('#crmList .crow .cacts button[data-st="won"]').click()`);
await new Promise((r) => setTimeout(r, 300));
check('marking someone won updates the row immediately',
  (await evaluate(`document.querySelector('#crmList .crow .cst').textContent`)) === 'won',
  await evaluate(`document.querySelector('#crmList .crow .cst').textContent`));
check('and the button shows which one is set',
  await evaluate(`document.querySelector('#crmList .crow .cacts button[data-st="won"]').classList.contains('on')`));

// An empty list must say so, not sit there looking broken.
await load({ P5: { state: 'active', endsAt: 9999999999 } }, { entitled: false },
  { entitled: true, slug: 'test-shop', contacts: [], summary: { total: 0, new: 0, contacted: 0, won: 0, lost: 0 }, automation: null });
check('an empty list explains itself',
  (await evaluate(`document.getElementById('crmNote').textContent`)).toLowerCase().includes('nobody has contacted you'),
  await evaluate(`document.getElementById('crmNote').textContent`));
check('and the automation counts hide when P6 is off',
  await evaluate(`document.getElementById('autoStat').hidden === true`));

console.log('\nA PANEL THAT CANNOT LOAD MUST NOT SHOW SWITCHES');
// The reported bug: switches read ON, would not stay off, and were back on
// after a reload. Cause was two PAID modules hardcoded active as a preview,
// which became the whole screen whenever the real state could not be fetched.
// Saving failed the same way loading had, so switching them off did nothing.
await load({}, { entitled: false }, { entitled: false }, true);
check('no javascript errors', consoleErrors.length === 0, consoleErrors.join(' | '));
check('NO switches are rendered at all',
  (await evaluate(offered)).length === 0, JSON.stringify(await evaluate(offered)));
check('it says the link is the problem',
  (await evaluate(`document.getElementById('mlist').textContent`)).toLowerCase().includes('expired'),
  await evaluate(`document.getElementById('mlist').textContent`));
check('and the running total is hidden, so no price is implied',
  await evaluate(`document.getElementById('totalbar').hidden === true`));

// A link carrying no access code at all, which /master had started emitting for
// accounts predating token nonces. This is the exact URL shape reported.
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/panel?e=v%40example.com` });
await new Promise((r) => setTimeout(r, 900));
check('a link with no access code shows no switches either',
  (await evaluate(offered)).length === 0, JSON.stringify(await evaluate(offered)));
check('and nothing on the page reads as switched on',
  !(await evaluate(`document.getElementById('mlist').innerHTML`)).includes('aria-checked="true"'));

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
try { chrome.kill(); } catch { /* already gone */ }
server.close();
process.exit(fail ? 1 : 0);
