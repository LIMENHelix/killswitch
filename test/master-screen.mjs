// Verifies the OTHER half of the editor fix in a real browser: clicking Edit must
// fill the form from the full record, not from the six-field summary.
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

// Repo root, derived from this file's own location so the suite runs
// from any checkout rather than only from C:/Users/Chris/killswitch.
const ROOT = path.join(import.meta.dirname, '..');

const FULL = {
  slug: 'test-shop', business: 'Test Shop', email: 'shop@example.com', trade: 'auto repair',
  phone: '816-555-0101', street: '123 Main St', city: 'Lenexa', state: 'KS', zip: '66215',
  about: 'Family run since 1998.', tagline: 'Brakes done right', accent: '#12703C',
  googleBusinessProfile: 'https://maps.app.goo.gl/TestShop', bookingUrl: '', payUrl: '', email_public: '',
  hours: [{ d: 'Mon to Fri', h: '8am to 6pm' }],
  services: [{ name: 'Brakes', desc: 'Pads and rotors' }],
  posts: [], modules: ['P0', 'P3'], published: true,
};
const SUMMARY = { slug: FULL.slug, business: FULL.business, email: FULL.email, trade: FULL.trade, published: true, modules: FULL.modules };
let sawSiteGet = false, saved = null, bulkCalls = 0;

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/master')) {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      res.setHeader('content-type', 'application/json');
      if (body.action === 'site-list') return res.end(JSON.stringify({
        ok: true, sites: [SUMMARY], total: 1,
        counts: { all: 3, published: 1, drafts: 2 }, offset: 0, limit: 100,
      }));
      if (body.action === 'site-bulk-draft') {
        bulkCalls++;
        return res.end(JSON.stringify(bulkCalls === 1
          ? { ok: true, created: 200, remaining: 50, skippedNoId: 0 }
          : { ok: true, created: 50, remaining: 0, skippedNoId: 2 }));
      }
      if (body.action === 'site-migrate') return res.end(JSON.stringify({ ok: true, migrated: 7 }));
      if (body.action === 'site-get') { sawSiteGet = true; return res.end(JSON.stringify({ ok: true, site: FULL })); }
      if (body.action === 'site-save') { saved = body.site; return res.end(JSON.stringify({ ok: true, site: { ...FULL, ...body.site } })); }
      return res.end(JSON.stringify({
        ok: true,
        accounts: [{
          email: 'shop@example.com', name: 'Test Shop', site: 'Test Shop', switches: ['Online Booking'],
          mrr: 19, portalUrl: '/panel?e=shop%40example.com&t=test', attached: true, working: true,
          siteSlug: 'test-shop', lifecycle: {
            stage: 'active', status: 'blocked', requiredStage: 'integrations_required', blocker: 'calendar_booking_url',
          },
        }],
        totals: { customers: 1, paying: 1, mrr: 19, attention: 1 }, stripe: true,
      }));
    });
    return;
  }
  res.setHeader('content-type', 'text/html');
  res.end(fs.readFileSync(path.join(ROOT, 'master.html')));
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('Chrome not found'); process.exit(2); }
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--no-first-run',
  '--no-default-browser-check', '--disable-gpu', '--user-data-dir=' + path.join(os.tmpdir(), 'ks-cdp-m' + PORT), 'about:blank'],
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
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
});
const send = (method, params = {}, sid = sessionId) => new Promise((res) => {
  const n = ++id; waiting.set(n, res); ws.send(JSON.stringify({ id: n, method, params, ...(sid ? { sessionId: sid } : {}) }));
});
const { result: t } = await send('Target.createTarget', { url: 'about:blank' }, null);
({ result: { sessionId } } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true }, null));
await send('Runtime.enable'); await send('Page.enable');
const evaluate = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result.result.value;

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/master` });
await new Promise((r) => setTimeout(r, 1000));
await evaluate(`document.getElementById('key').value='k'; document.getElementById('loginBtn').click();`);
await new Promise((r) => setTimeout(r, 1600));

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };

console.log('\nMASTER website editor');
check('no javascript errors', errors.length === 0, errors.join(' | '));
check('the site list rendered', (await evaluate(`document.querySelectorAll('#sTb [data-edit]').length`)) === 1);
check('the lifecycle attention tile is visible', (await evaluate(`document.getElementById('tiles').textContent`)).includes('Needs setup'));
check('the customer row names the missing integration', (await evaluate(`document.getElementById('tb').textContent`)).includes('calendar_booking_url'));

await evaluate(`document.querySelector('#sTb [data-edit]').click()`);
await new Promise((r) => setTimeout(r, 600));
check('Edit calls site-get, not site-list', sawSiteGet);
check('phone is filled from the full record', (await evaluate(`document.getElementById('f_phone').value`)) === '816-555-0101');
check('address is filled', (await evaluate(`document.getElementById('f_city').value`)) === 'Lenexa');
check('about text is filled', (await evaluate(`document.getElementById('f_about').value`)) === 'Family run since 1998.');
check('Google profile is filled', (await evaluate(`document.getElementById('f_googleBusinessProfile').value`)) === 'https://maps.app.goo.gl/TestShop');
check('hours repeater is populated', (await evaluate(`document.querySelectorAll('#r_hours .rep').length`)) === 1);
check('services repeater is populated', (await evaluate(`document.querySelectorAll('#r_services .rep').length`)) === 1);

// change one field and save, the way a rep would
await evaluate(`document.getElementById('f_tagline').value='Brakes done right, fast'; document.getElementById('sSave').click();`);
await new Promise((r) => setTimeout(r, 600));
check('save carries the phone number back', saved && saved.phone === '816-555-0101', JSON.stringify(saved && saved.phone));
check('save carries the address back', saved && saved.city === 'Lenexa' && saved.zip === '66215');
check('save carries the Google profile back', saved && saved.googleBusinessProfile === 'https://maps.app.goo.gl/TestShop');
check('save carries hours and services back', saved && saved.hours.length === 1 && saved.services.length === 1);
check('the edit itself landed', saved && saved.tagline === 'Brakes done right, fast');
check('P10 is gone from the module list', !(await evaluate(`document.getElementById('f_mods').textContent`)).includes('P10'));

console.log('\nBULK DRAFTING');
check('the draft/live counts are shown', (await evaluate(`document.getElementById('bulkCounts').textContent`)) === '3 built · 1 live · 2 still drafts');
check('the state badge names all three states',
  (await evaluate(`document.querySelector('#sTb .st').className`)).includes('claimed')
  || (await evaluate(`document.querySelector('#sTb .st').textContent`)).length > 0);

// auto-accept the confirm, then let the loop drive itself to completion
await evaluate(`window.confirm = () => true; document.getElementById('bulkGo').click();`);
await new Promise((r) => setTimeout(r, 1400));
check('it batches until there is nothing left', bulkCalls >= 2, 'calls=' + bulkCalls);
const msg = await evaluate(`document.getElementById('bulkMsg').textContent`);
check('it reports what it built', msg.includes('250 drafts built'), msg);
check('and says they are invisible until published', msg.includes('404'), msg);
check('the button is usable again', await evaluate(`document.getElementById('bulkGo').disabled === false`));

await evaluate(`document.getElementById('sMigrate').click()`);
await new Promise((r) => setTimeout(r, 500));
check('migrate reports what moved', (await evaluate(`document.getElementById('bulkMsg').textContent`)).includes('7 site'));

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
chrome.kill(); server.close();
process.exit(fail ? 1 : 0);
