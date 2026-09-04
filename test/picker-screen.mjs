// Does the look picker actually DRAW, in a real browser?
//
// The theme tests assert against api/theme.js and against panel.html as source
// text. Source regexes cannot tell you the thing rendered, that the badge says
// the right word, or that a disabled state really disables. This loads the real
// panel.html in headless Chrome against a stubbed /api/theme.
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

// Repo root, derived from this file's own location so the suite runs from any
// checkout rather than only from C:/Users/Chris/killswitch.
const ROOT = path.join(import.meta.dirname, '..');
const PANEL = path.join(ROOT, 'panel.html');

let THEME_REPLY = {};
let lastSet = null;

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/theme')) {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      res.setHeader('content-type', 'application/json');
      if (body.action === 'set') {
        lastSet = body.theme;
        const w = !!THEME_REPLY.written;
        res.end(JSON.stringify({
          ok: true, current: body.theme, label: body.theme, written: w, applied: !w,
          siteUrl: '/s/test-shop',
          message: w ? 'Saved, but your site has a page written specially for it, so it still looks the same.' : '',
        }));
        return;
      }
      res.end(JSON.stringify(THEME_REPLY));
    });
    return;
  }
  if (req.url.startsWith('/api/switch')) {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, site: 'test-shop', name: 'Test Shop', linked: true, modules: {} }));
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
if (!CHROME) { console.log('Chrome not found'); process.exit(2); }

const userDir = path.join(os.tmpdir(), 'ks-picker-cdp-' + PORT);
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--no-first-run',
  '--no-default-browser-check', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--user-data-dir=' + userDir, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });

const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  const t = setTimeout(() => reject(new Error('no debug port')), 20000);
  chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/ws:\/\/[^\s]+/); if (m) { clearTimeout(t); resolve(m[0]); } });
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const waiting = new Map(); const consoleErrors = []; let sessionId = null;
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(m.params.args.map((a) => a.value || a.description).join(' '));
});
const send = (method, params = {}, sid = sessionId) => new Promise((res) => {
  const n = ++id; waiting.set(n, res);
  ws.send(JSON.stringify({ id: n, method, params, ...(sid ? { sessionId: sid } : {}) }));
});
const { result: t } = await send('Target.createTarget', { url: 'about:blank' }, null);
({ result: { sessionId } } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true }, null));
await send('Runtime.enable'); await send('Page.enable');

const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.result.value;
async function load(reply) {
  THEME_REPLY = reply; lastSet = null; consoleErrors.length = 0;
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/panel?e=shop%40example.com&t=tok` });
  await new Promise((r) => setTimeout(r, 1500));
}

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };

const CAT = [
  { id: 'warm', label: 'Warm', note: 'Cream and deep green. The original.', swatch: { bg: '#F6F1E7', ink: '#1E1B16', ac: '#12703C' } },
  { id: 'clean', label: 'Clean', note: 'White and blue.', swatch: { bg: '#FFFFFF', ink: '#14171A', ac: '#1D4ED8' } },
  { id: 'midnight', label: 'Midnight', note: 'Dark background.', swatch: { bg: '#14171C', ink: '#EEF1F5', ac: '#38BDF8' } },
  { id: 'bold', label: 'Bold', note: 'Heavy type and red.', swatch: { bg: '#FFFFFF', ink: '#0A0A0A', ac: '#DC2626' } },
  { id: 'coastal', label: 'Coastal', note: 'Cool grey and teal.', swatch: { bg: '#F5F7FA', ink: '#0F172A', ac: '#0F766E' } },
];

console.log('\nA NORMAL TEMPLATE SITE');
await load({ ok: true, current: 'warm', themes: CAT, siteUrl: '/s/test-shop', written: false, message: '' });
check('no javascript errors', consoleErrors.length === 0, consoleErrors.join(' | '));
check('the picker section is visible', (await evaluate(`!document.getElementById('themeWrap').hidden`)));
check('all five looks are drawn', (await evaluate(`document.querySelectorAll('#thList .th').length`)) === 5);
check('none of them is disabled', (await evaluate(`[...document.querySelectorAll('#thList .th')].filter(b=>b.disabled).length`)) === 0);
check('the current one is marked ON', (await evaluate(`document.querySelector('#thList .th[data-id="warm"] .nm').textContent`)).includes('ON'));
check('the others are not marked', (await evaluate(`document.querySelector('#thList .th[data-id="bold"] .nm').textContent`)).trim() === 'Bold');
check('the swatch carries the real background colour',
  (await evaluate(`document.querySelector('#thList .th[data-id="midnight"] .prev').getAttribute('style')`)).includes('#14171C'));

console.log('\n  clicking one');
await evaluate(`document.querySelector('#thList .th[data-id="bold"]').click()`);
await new Promise((r) => setTimeout(r, 700));
check('it posted the chosen theme', lastSet === 'bold', String(lastSet));
check('the marker moved to the new one', (await evaluate(`document.querySelector('#thList .th[data-id="bold"] .nm').textContent`)).includes('ON'));
check('and left the old one', !(await evaluate(`document.querySelector('#thList .th[data-id="warm"] .nm').textContent`)).includes('ON'));
check('it says the site changed', (await evaluate(`document.getElementById('thNote').textContent`)).includes('Open it to see it'));

console.log('\nA SITE WITH A PAGE WRITTEN SPECIALLY FOR IT');
await load({ ok: true, current: 'midnight', themes: CAT, siteUrl: '/s/test-shop', written: true,
  message: 'Your site has a page written specially for it, so these looks do not change it.' });
check('no javascript errors', consoleErrors.length === 0, consoleErrors.join(' | '));
check('the picker is still usable, not dead', (await evaluate(`[...document.querySelectorAll('#thList .th')].filter(b=>b.disabled).length`)) === 0);
check('the marker says SAVED, not ON', (await evaluate(`document.querySelector('#thList .th[data-id="midnight"] .nm').textContent`)).includes('SAVED'));
check('it does NOT claim to be ON', !/\bON\b/.test(await evaluate(`document.querySelector('#thList .th[data-id="midnight"] .nm').textContent`)));
check('the reason is shown', (await evaluate(`document.getElementById('thNote').textContent`)).includes('written specially for it'));
await evaluate(`document.querySelector('#thList .th[data-id="clean"]').click()`);
await new Promise((r) => setTimeout(r, 700));
check('a choice still saves', lastSet === 'clean', String(lastSet));
check('the new marker also says SAVED', (await evaluate(`document.querySelector('#thList .th[data-id="clean"] .nm').textContent`)).includes('SAVED'));
check('and it is NOT told to go and look', !(await evaluate(`document.getElementById('thNote').textContent`)).includes('Open it to see it'));
check('it is told the page still looks the same', (await evaluate(`document.getElementById('thNote').textContent`)).includes('still looks the same'));

console.log('\nA CUSTOMER WHOSE SITE IS NOT BUILT YET');
await load({ ok: true, current: 'warm', themes: CAT, noSite: true,
  message: 'Your website is being put together. You will be able to pick a look as soon as it is up.' });
check('no javascript errors', consoleErrors.length === 0, consoleErrors.join(' | '));
check('every button is disabled', (await evaluate(`[...document.querySelectorAll('#thList .th')].filter(b=>b.disabled).length`)) === 5);
check('and the message matches that', (await evaluate(`document.getElementById('thNote').textContent`)).includes('as soon as it is up'));
await evaluate(`document.querySelector('#thList .th[data-id="bold"]').click()`);
await new Promise((r) => setTimeout(r, 500));
check('clicking a disabled one posts nothing', lastSet === null, String(lastSet));

console.log('\nTHE PICKER NEVER BREAKS THE REST OF THE PANEL');
await load({ error: 'server_error' });
check('a failing endpoint leaves the picker hidden', (await evaluate(`document.getElementById('themeWrap').hidden`)));
check('and the module switchboard still rendered', (await evaluate(`document.querySelectorAll('#mlist .mrow').length`)) > 0);
check('with no javascript errors', consoleErrors.length === 0, consoleErrors.join(' | '));

console.log(`\n${pass} passed, ${fail} failed\n`);
try { chrome.kill(); } catch { /* gone */ }
server.close();
process.exit(fail ? 1 : 0);
