
import path from 'node:path';
// Repo root, derived from this file's own location so the suite runs
// from any checkout rather than only from C:/Users/Chris/killswitch.
const ROOT = path.join(import.meta.dirname, '..');
// Exercises the REAL handlers (api/support.js, api/switch.js) against a stubbed
// Upstash KV and Stripe, so the fixes are tested rather than asserted.
// Run: node ks-gate-test.mjs
process.env.KV_REST_API_URL = 'https://kv.test/';
process.env.KV_REST_API_TOKEN = 'kvtok';
process.env.STRIPE_SECRET_KEY = 'sk_test_stub';
process.env.KS_PANEL_SECRET = 'panelsecret';
process.env.ANTHROPIC_API_KEY = 'ant_stub';
delete process.env.RESEND_API_KEY;   // notify becomes a no-op, must never throw

const KV = new Map();
let stripeSubs = [];        // subscriptions the fake Stripe knows about
let stripeCustomers = [];   // customers by email
let created = [];           // checkout sessions created

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });

  if (u.startsWith('https://kv.test')) {
    const args = JSON.parse(opts.body);
    const run = (a) => {
      const [cmd, key, f, v] = a;
      if (cmd === 'GET') return KV.has(key) ? KV.get(key) : null;
      // NX first: the generic SET below would otherwise swallow it and store the
      // literal string "NX" as the value.
      if (cmd === 'SET' && a[3] === 'NX') { if (KV.has(key)) return null; KV.set(key, f); return 'OK'; }
      if (cmd === 'SET') { KV.set(key, v === undefined ? f : v); return 'OK'; }
      if (cmd === 'HSET') { const h = KV.get(key) || {}; h[f] = v; KV.set(key, h); return 1; }
      if (cmd === 'HGET') { const h = KV.get(key) || {}; return h[f] == null ? null : h[f]; }
      if (cmd === 'HDEL') { const h = KV.get(key) || {}; delete h[f]; KV.set(key, h); return 1; }
      if (cmd === 'HGETALL') {
        const h = KV.get(key) || {};
        const flat = []; for (const [k, val] of Object.entries(h)) flat.push(k, val);
        return flat;
      }
      // Visitor counters (lib/stats.js). Upstash returns the new value.
      if (cmd === 'INCR') { const n = Number(KV.get(key) || 0) + 1; KV.set(key, String(n)); return n; }
      if (cmd === 'DEL') { KV.delete(key); return 1; }
      if (cmd === 'HKEYS') return Object.keys(KV.get(key) || {});
      // The follow-up queue (lib/automation.js) is a sorted set: member -> score.
      if (cmd === 'ZADD') {
        const z = KV.get(key) || {};
        // ['ZADD', key, 'NX', score, member] or ['ZADD', key, score, member]
        const nx = a[2] === 'NX';
        const score = Number(nx ? a[3] : a[2]);
        const member = nx ? a[4] : a[3];
        if (nx && z[member] !== undefined) return 0;
        z[member] = score; KV.set(key, z); return 1;
      }
      if (cmd === 'ZREM') { const z = KV.get(key) || {}; delete z[f]; KV.set(key, z); return 1; }
      if (cmd === 'ZRANGE') {
        const z = KV.get(key) || {};
        return Object.keys(z).sort((x, y) => z[x] - z[y]);
      }
      if (cmd === 'ZRANGEBYSCORE') {
        const z = KV.get(key) || {};
        const min = a[2] === '-inf' ? -Infinity : Number(a[2]);
        const max = a[3] === '+inf' ? Infinity : Number(a[3]);
        let out = Object.keys(z).filter((m) => z[m] >= min && z[m] <= max).sort((x, y) => z[x] - z[y]);
        const li = a.indexOf('LIMIT');
        if (li > -1) out = out.slice(Number(a[li + 1]), Number(a[li + 1]) + Number(a[li + 2]));
        return out;
      }
      // No TTL in this Map, so EXPIRE is accepted and ignored. That means the
      // 100 day cleanup on daily rows is NOT covered here; it is a Redis
      // behaviour, not ours, and faking a clock to test it would prove nothing.
      if (cmd === 'EXPIRE') return 1;
      throw new Error('unexpected kv cmd ' + cmd);
    };
    // /pipeline takes an array of command arrays and returns one result each
    if (u.endsWith('/pipeline')) return json(args.map((a) => ({ result: run(a) })));
    return json({ result: run(args) });
  }

  if (u.startsWith('https://api.stripe.com/v1')) {
    const path = u.slice('https://api.stripe.com/v1'.length);
    if (path.startsWith('/subscriptions?')) return json({ data: stripeSubs, has_more: false });
    if (path.startsWith('/customers?')) {
      const email = decodeURIComponent((path.match(/email=([^&]+)/) || [])[1] || '');
      return json({ data: stripeCustomers.filter((c) => c.email === email) });
    }
    if (path === '/checkout/sessions' && opts.method === 'POST') {
      created.push(opts.body);
      return json({ url: 'https://checkout.stripe.com/pay/cs_test_1', id: 'cs_test_1' });
    }
    if (path.startsWith('/checkout/sessions/')) {
      return json({ customer: 'cus_paid', payment_status: 'paid', amount_total: 1900 });
    }
    // These used to return a canned OK and leave stripeSubs untouched, so a test
    // could not tell a real cancellation from a no-op: the next read handed back
    // the pre-change subscription and everything looked "still active". The stub
    // mutates now, so switching something off is observed rather than assumed.
    const form = (b) => Object.fromEntries(new URLSearchParams(String(b || '')));
    if (path.startsWith('/subscription_items/') && opts.method === 'DELETE') {
      const id = path.slice('/subscription_items/'.length).split('?')[0];
      for (const s of stripeSubs) s.items.data = s.items.data.filter((it) => it.id !== id);
      return json({ id, deleted: true });
    }
    if (path === '/subscription_items' && opts.method === 'POST') {
      const f = form(opts.body);
      const sub = stripeSubs.find((s) => s.id === f.subscription);
      const item = { id: 'si_' + f.price.slice(-6), price: { id: f.price }, current_period_end: 9999999999 };
      if (sub) sub.items.data.push(item);
      return json(item);
    }
    if (path.startsWith('/subscriptions/')) {
      const id = path.slice('/subscriptions/'.length).split('?')[0];
      const sub = stripeSubs.find((s) => s.id === id);
      const f = form(opts.body);
      if (sub && f.cancel_at_period_end !== undefined) sub.cancel_at_period_end = f.cancel_at_period_end === 'true';
      return json(sub || { id, current_period_end: 9999999999 });
    }
    throw new Error('unexpected stripe path ' + path);
  }

  if (u.startsWith('https://api.anthropic.com')) {
    const sent = JSON.parse(opts.body || '{}');
    anthropicCalls.push(sent);
    if (sent.model === 'claude-opus-5') {
      if (siteWriterReply !== null) return json(siteWriterReply);
      return json({ stop_reason: 'end_turn', content: [{ type: 'text', text:
        '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Test Shop</title>\n<meta name="description" content="x">\n<style>body{font:16px/1.5 Georgia,serif;background:#f6f1e7}</style>\n</head>\n<body><h1>Test Shop</h1><p><a href="tel:+18165550101">816-555-0101</a></p>' + 'x'.repeat(900) + '</body>\n</html>' }] });
    }
    return json({ content: [{ type: 'text', text: 'Got it, I will pass that to your builder.' }] });
  }
  if (u.startsWith('https://api.lob.com')) {
    lobCards.push(String(opts.body || ''));
    return json({ id: 'psc_' + lobCards.length });
  }
  throw new Error('unexpected fetch ' + u);
};
const lobCards = [];
const anthropicCalls = [];
let siteWriterReply = null;

const { panelToken, signPanel, verifyPanel, revokePanelTokens } = await import('../lib/panel-auth.js');
const support = (await import('../api/support.js')).default;
const switchApi = (await import('../api/switch.js')).default;

function mkres() {
  const r = { code: 0, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (o) => { r.body = o; return r; };
  // A real response has end(), used for 204s that carry no body. Without it the
  // harness was not just incomplete, it was less capable than production and
  // would fail a handler that is perfectly correct.
  r.end = () => r;
  r.setHeader = () => {};
  r.send = (b) => { r.body = b; return r; };
  return r;
}
const call = async (h, body) => { const res = mkres(); await h({ method: 'POST', body, headers: { host: 'test.local' } }, res); return res; };

const EMAIL = 'shop@example.com';
// Every seeded account carries this nonce, so a token can be minted
// synchronously here instead of awaiting a KV read at module load.
const NONCE = 'testnonce0000';
const TOK = signPanel(EMAIL, NONCE, Date.now() + 90 * 86400000);
const P3 = 'price_1ToXlsPmxnF3rtBM9Dc9mDul';  // Online Booking
const P11 = 'price_1TnMiMPmxnF3rtBMgqTJpLh6'; // Care Plan

// Sites are one key each now (ks:site:<slug>) with a summary index, so the test
// writes them the same way the code does.
function putSite(rec) {
  KV.set('ks:site:' + rec.slug, JSON.stringify(rec));
  const idx = KV.get('ks:siteidx') || {};
  idx[rec.slug] = JSON.stringify({
    business: rec.business, email: rec.email || '', trade: rec.trade || '', city: rec.city || '',
    published: !!rec.published, claimed: !!rec.claimed, modules: rec.modules || ['P0'],
    source: rec.source || '', leadId: rec.leadId || '',
  });
  KV.set('ks:siteidx', idx);
  if (rec.email) { const em = KV.get('ks:siteemail') || {}; em[rec.email.toLowerCase()] = rec.slug; KV.set('ks:siteemail', em); }
}
function seed() {
  KV.clear(); stripeSubs = []; stripeCustomers = []; created = [];
  KV.set('ks:accounts', JSON.stringify({ [EMAIL]: { email: EMAIL, tokenNonce: NONCE, name: 'Test Shop', plan: ['P0'] } }));
  putSite({ slug: 'test-shop', business: 'Test Shop', email: EMAIL, phone: '816-555-0101', modules: ['P0'], published: true, claimed: true });
}
const site = () => JSON.parse(KV.get('ks:site:test-shop'));
const acct = () => JSON.parse(KV.get('ks:accounts'))[EMAIL];

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  PASS  ' + name); pass++; }
  else { console.log('  FAIL  ' + name + (detail ? '  <- ' + detail : '')); fail++; }
}

// ---------------------------------------------------------------------------
console.log('\n1. Custom work is not free any more');
seed();
let r = await call(support, { action: 'ask', e: EMAIL, t: TOK, messages: [{ role: 'user', content: 'change my hours' }] });
check('free customer asking for an edit is refused', r.code === 403 && r.body.error === 'not_entitled', 'got ' + r.code + ' ' + JSON.stringify(r.body));

r = await call(support, { action: 'submit', e: EMAIL, t: TOK, requests: ['new hours'] });
check('free customer cannot file a work order', r.code === 403, 'got ' + r.code);

r = await call(support, { action: 'ask', e: EMAIL, t: 'forged', messages: [{ role: 'user', content: 'hi' }] });
check('no token, no Anthropic call (was wide open)', r.code === 401, 'got ' + r.code);

// now they buy the Care Plan
stripeSubs = [{ id: 'sub_care', status: 'active', cancel_at_period_end: false, current_period_end: 9999999999,
  items: { data: [{ id: 'si_care', price: { id: P11, recurring: { interval: 'month' }, unit_amount: 9900 }, current_period_end: 9999999999 }] } }];
KV.set('ks:accounts', JSON.stringify({ [EMAIL]: { ...acct(), stripeCustomerId: 'cus_paid' } }));
r = await call(support, { action: 'ask', e: EMAIL, t: TOK, messages: [{ role: 'user', content: 'change my hours' }] });
check('Care Plan customer gets the assistant', r.code === 200 && !!r.body.reply, 'got ' + r.code + ' ' + JSON.stringify(r.body));
r = await call(support, { action: 'submit', e: EMAIL, t: TOK, requests: ['open at 7am'] });
check('Care Plan customer can file a work order', r.code === 200 && r.body.ok === true, 'got ' + r.code);

// ---------------------------------------------------------------------------
console.log('\n2. A paid module does not go live before the money does');
seed();
r = await call(switchApi, { action: 'apply', e: EMAIL, t: TOK, on: ['P3'] });
check('customer is sent to Stripe checkout', !!(r.body && r.body.url), JSON.stringify(r.body));
check('site does NOT get Online Booking yet', !site().modules.includes('P3'), 'modules=' + JSON.stringify(site().modules));
check('the free site itself is untouched', site().modules.includes('P0') && site().phone === '816-555-0101');

// they abandon the checkout and come back later: still not live
r = await call(switchApi, { action: 'state', e: EMAIL, t: TOK });
check('abandoned checkout leaves it off', !site().modules.includes('P3'), 'modules=' + JSON.stringify(site().modules));

// they actually pay, and the browser returns to success_url
stripeSubs = [{ id: 'sub_1', status: 'active', cancel_at_period_end: false, current_period_end: 9999999999,
  items: { data: [{ id: 'si_1', price: { id: P3, recurring: { interval: 'month' }, unit_amount: 1900 }, current_period_end: 9999999999 }] } }];
r = await call(switchApi, { action: 'link', e: EMAIL, t: TOK, session_id: 'cs_test_1' });
check('link succeeds', r.code === 200 && r.body.ok === true, JSON.stringify(r.body));
check('NOW Online Booking is live on the site', site().modules.includes('P3'), 'modules=' + JSON.stringify(site().modules));

// ---------------------------------------------------------------------------
console.log('\n3. A payment that never came back to us repairs itself');
seed();
// They paid on Stripe, then closed the tab. Account has no stripeCustomerId.
stripeCustomers = [{ id: 'cus_lost', email: EMAIL }];
stripeSubs = [{ id: 'sub_lost', status: 'active', cancel_at_period_end: false, current_period_end: 9999999999,
  items: { data: [{ id: 'si_lost', price: { id: P3, recurring: { interval: 'month' }, unit_amount: 1900 }, current_period_end: 9999999999 }] } }];
check('before: account looks free', !acct().stripeCustomerId);
r = await call(switchApi, { action: 'state', e: EMAIL, t: TOK });
check('opening the panel finds the lost payment', acct().stripeCustomerId === 'cus_lost', 'id=' + acct().stripeCustomerId);
check('panel now shows the module they paid for', !!(r.body.modules && r.body.modules.P3), JSON.stringify(r.body.modules));
check('their site is caught up too', site().modules.includes('P3'), 'modules=' + JSON.stringify(site().modules));

// ---------------------------------------------------------------------------
console.log('\n4. The website editor stops deleting the customer');
process.env.ADMIN_KEY = 'testadminkey';
const master = (await import('../api/master.js')).default;
const asAdmin = (body) => call(master, { token: 'testadminkey', ...body });

KV.clear();
putSite({
  slug: 'test-shop', business: 'Test Shop', email: EMAIL, trade: 'auto repair',
  phone: '816-555-0101', street: '123 Main St', city: 'Lenexa', state: 'KS', zip: '66215',
  about: 'Family run since 1998.', tagline: 'Brakes done right',
  hours: [{ d: 'Mon to Fri', h: '8am to 6pm' }],
  services: [{ name: 'Brakes', desc: 'Pads and rotors' }],
  modules: ['P0', 'P3'], published: true, claimed: true,
});

r = await asAdmin({ action: 'site-list' });
const summary = r.body.sites[0];
check('site-list is only a summary (this is the trap)', summary.phone === undefined && summary.about === undefined);

r = await asAdmin({ action: 'site-get', slug: 'test-shop' });
check('site-get returns the whole record', r.code === 200 && r.body.site.phone === '816-555-0101' && r.body.site.hours.length === 1, JSON.stringify(r.body.site && r.body.site.phone));

// What the editor now does: load full, change one thing, send it all back.
const loaded = r.body.site;
r = await asAdmin({ action: 'site-save', site: { ...loaded, tagline: 'Brakes done right, fast' } });
check('a normal edit keeps the phone number', site().phone === '816-555-0101', 'phone=' + site().phone);
check('a normal edit keeps the address', site().city === 'Lenexa' && site().zip === '66215');
check('a normal edit keeps hours and services', site().hours.length === 1 && site().services.length === 1);
check('the change itself landed', site().tagline === 'Brakes done right, fast');

// The old failure mode, replayed: a payload that simply omits the other fields.
r = await asAdmin({ action: 'site-save', site: { slug: 'test-shop', business: 'Test Shop' } });
check('a partial save no longer blanks anything', site().phone === '816-555-0101' && site().about === 'Family run since 1998.' && site().hours.length === 1,
  JSON.stringify({ phone: site().phone, about: site().about, hours: site().hours.length }));
check('modules survive a partial save', site().modules.includes('P3'), JSON.stringify(site().modules));

// ---------------------------------------------------------------------------
console.log('\n5. A rep key is not the owner key');
process.env.REP_KEYS = 'dana:r_dana_key,mike:r_mike_key';
const admin = (await import('../api/admin.js')).default;
const signup = (await import('../api/signup.js')).default;

KV.clear();
KV.set('ks:leads', JSON.stringify([
  { id: 'L1', name: 'Auto Tech Services Center', trade: 'auto repair', phone: '913-268-7887', street: '1 A St', state: 'KS', zip: '66203' },
  { id: 'L2', name: 'Autobots Garage', trade: 'auto repair', phone: '913-722-5151', street: '2 B St', state: 'KS', zip: '66203' },
]));

r = await call(admin, { action: 'list', token: 'testadminkey' });
check('owner can read the board', r.code === 200 && r.body.role === 'owner', JSON.stringify(r.body && r.body.role));
r = await call(admin, { action: 'list', token: 'r_dana_key' });
check('rep can read the board', r.code === 200 && r.body.role === 'rep' && r.body.name === 'dana', JSON.stringify({ role: r.body.role, name: r.body.name }));
r = await call(admin, { action: 'list', token: 'not_a_key' });
check('a wrong key gets nothing', r.code === 401);

for (const act of ['mail', 'setconfig', 'run-autopilot', 'seed']) {
  r = await call(admin, { action: act, token: 'r_dana_key', ids: ['L1'], enabled: true, budgetCeiling: 999, leads: [] });
  check('rep is refused: ' + act, r.code === 403 && r.body.error === 'forbidden', 'got ' + r.code);
}

r = await call(master, { action: 'list', token: 'r_dana_key' });
check('rep cannot open /master', r.code === 401, 'got ' + r.code);
{
  const res = mkres();
  await signup({ method: 'POST', query: { token: 'r_dana_key' }, body: { email: 'x@y.com' }, headers: {} }, res);
  check('rep cannot mint a customer account', res.code === 401, 'got ' + res.code);
}

// attribution
r = await call(admin, { action: 'update', token: 'r_dana_key', id: 'L1', stage: 'called' });
check('the rep who worked it owns it', r.body.meta && r.body.meta.owner === 'dana', JSON.stringify(r.body.meta));
r = await call(admin, { action: 'update', token: 'r_mike_key', id: 'L1', stage: 'responded' });
check('a second rep does not steal the lead', r.body.meta.owner === 'dana' && r.body.meta.stage === 'responded', JSON.stringify(r.body.meta));
r = await call(admin, { action: 'update', token: 'testadminkey', id: 'L1', owner: 'mike' });
check('the owner can reassign it', r.body.meta.owner === 'mike', JSON.stringify(r.body.meta));

// the clobber that made two people unsafe
r = await call(admin, { action: 'update', token: 'r_dana_key', id: 'L2', notes: 'left a voicemail' });
r = await call(admin, { action: 'list', token: 'testadminkey' });
const l1 = r.body.leads.find((x) => x.id === 'L1'), l2 = r.body.leads.find((x) => x.id === 'L2');
// `responded` reads back as `appointment`: the funnel record is authoritative for
// stage now, and a lead with only the old vocabulary is migrated on read.
check('two people on different leads both survive', l1.stage === 'appointment' && l2.notes === 'left a voicemail',
  JSON.stringify({ l1: l1.stage, l2: l2.notes }));
check('lead identity is intact after all that', l1.name === 'Auto Tech Services Center' && l2.phone === '913-722-5151');

// ---------------------------------------------------------------------------
console.log('\n6. Sites for everyone: draft, deliver, claim');
process.env.LOB_API_KEY = 'test_stub';
process.env.KS_FROM_NAME = 'Killswitch'; process.env.KS_FROM_LINE1 = '1 Main St';
process.env.KS_FROM_CITY = 'KC'; process.env.KS_FROM_STATE = 'MO'; process.env.KS_FROM_ZIP = '64111';
const siteApi = (await import('../api/site.js')).default;
const { renderSite } = await import('../lib/site-template.js');
const { getSite, upsertSite: upsertSiteFn } = await import('../lib/sites.js');

KV.clear(); lobCards.length = 0;
// a legacy blob site, to prove the migration path
KV.set('ks:sites', JSON.stringify({ 'old-shop': { slug: 'old-shop', business: 'Old Shop', email: 'old@x.com', published: true } }));
KV.set('ks:leads', JSON.stringify([
  { id: 'A', name: "Charlie's Brake & Muffler", trade: 'auto repair', phone: '913-859-9994', street: '12912 Santa Fe Trail Dr', city: 'Lenexa', state: 'KS', zip: '66215' },
  { id: 'B', name: 'Downtown Dental', trade: 'dentist', phone: '816-555-1212', street: '5 Elm St', city: 'Kansas City', state: 'MO', zip: '64111' },
  { id: 'C', name: "Charlie's Brake & Muffler", trade: 'auto repair', phone: '913-000-0000', street: '9 Other Rd', city: 'Olathe', state: 'KS', zip: '66061' },
  { name: 'No Id Shop', trade: 'bakery', street: '1 X', state: 'KS', zip: '66215' },
]));

r = await asAdmin({ action: 'site-migrate' });
check('the old blob migrates to per-slug keys', r.body.migrated === 1 && !!KV.get('ks:site:old-shop'), JSON.stringify(r.body));
check('an already-live site stays indexable after migrating', JSON.parse(KV.get('ks:site:old-shop')).claimed === true);

r = await asAdmin({ action: 'site-bulk-draft', limit: 2 });
check('drafts generate in batches', r.body.created === 2 && r.body.remaining === 1, JSON.stringify(r.body));
check('a lead with no id is skipped, and counted', r.body.skippedNoId === 1, JSON.stringify(r.body.skippedNoId));
r = await asAdmin({ action: 'site-bulk-draft', limit: 100 });
check('the rest generate, none repeated', r.body.created === 1 && r.body.remaining === 0, JSON.stringify(r.body));
r = await asAdmin({ action: 'site-bulk-draft', limit: 100 });
check('running it again creates nothing', r.body.created === 0, JSON.stringify(r.body));

const charlie = await getSite('charlies-brake-muffler');
check('same name in another city gets its own slug', !!(await getSite('charlies-brake-muffler-olathe')));
check('draft holds only facts we have', charlie.phone === '913-859-9994' && charlie.city === 'Lenexa' && charlie.about === '' && charlie.hours.length === 0);
check('trade services are filled in', charlie.services.length === 6 && charlie.services[0].name === 'Brakes');
const dental = await getSite('downtown-dental');
check('a medical practice gets NO invented service menu', dental.services.length === 0, JSON.stringify(dental.services));

// invisible until published
const mkq = (slug) => { const res = mkres(); res.setHeader = () => {}; res.send = (h) => { res.body = h; return res; }; return [{ method: 'GET', query: { slug }, headers: {} }, res]; };
let [rq, rs] = mkq('charlies-brake-muffler'); await siteApi(rq, rs);
check('an unpublished draft is a hard 404', rs.code === 404, 'got ' + rs.code);

// the rep publishes it on the call
r = await call(admin, { action: 'site-publish', token: 'r_dana_key', id: 'A' });
check('a rep can publish on the call', r.code === 200 && r.body.url === '/s/charlies-brake-muffler', JSON.stringify(r.body));
[rq, rs] = mkq('charlies-brake-muffler'); await siteApi(rq, rs);
check('now the link works', rs.code === 200 && rs.body.includes("Charlie's Brake"), 'got ' + rs.code);
check('but it is NOT indexable yet', rs.body.includes('name="robots" content="noindex'));
r = await call(admin, { action: 'site-save', token: 'r_dana_key' });
check('a rep still cannot edit site content', r.code === 400 || r.code === 403, 'got ' + r.code);

// the postcard carries the address of a site that exists
KV.set('ks:leadmeta', KV.get('ks:leadmeta') || {});
const { lobSend } = await import('../lib/mailer.js');
const meta = (KV.get('ks:leadmeta') || {});
const slugB = JSON.parse(meta.B).siteSlug;
await lobSend({ id: 'B', name: 'Downtown Dental', trade: 'dentist', street: '5 Elm St', city: 'Kansas City', state: 'MO', zip: '64111', siteSlug: slugB });
const card = decodeURIComponent(lobCards[0].replace(/\+/g, ' '));
check('the postcard prints their own URL', card.includes('killswitchwebsites.com/s/downtown-dental'), card.slice(0, 60));
check('the card says already built, not claim yours', card.includes('already built') && !card.includes('Claim your'));
check('mailing published the site so the URL resolves', (await getSite('downtown-dental')).published === true);
check('mailing did NOT make it indexable', (await getSite('downtown-dental')).claimed === false);

// they say yes: onboarding claims it
r = await asAdmin({ action: 'onboard', email: 'charlie@brakes.com', name: 'Charlie', slug: 'charlies-brake-muffler' });
check('onboarding claims the site', r.code === 200 && r.body.claimedSlug === 'charlies-brake-muffler', JSON.stringify(r.body));
const claimedSite = await getSite('charlies-brake-muffler');
check('claimed site is indexable at last', !renderSite(claimedSite, {}).includes('noindex'));
check('and it carries the customer email', claimedSite.email === 'charlie@brakes.com');

// the list stays cheap
r = await asAdmin({ action: 'site-list', limit: 2 });
check('site-list pages instead of shipping everything', r.body.sites.length === 2 && r.body.total === 4, JSON.stringify({ n: r.body.sites.length, total: r.body.total }));
check('and reports draft vs published counts', r.body.counts.all === 4 && r.body.counts.published === 3, JSON.stringify(r.body.counts));
r = await asAdmin({ action: 'site-list', q: 'olathe' });
check('search finds a shop by city', r.body.total === 1 && r.body.sites[0].slug === 'charlies-brake-muffler-olathe', JSON.stringify(r.body.sites.map((s) => s.slug)));

// ---------------------------------------------------------------------------
console.log('\n7. The voice agent on 913-933-1687');
process.env.AGENT_TOKEN = 'agent_test_tok';
process.env.KS_HUMAN_PHONE = '913-948-3747';
const agent = (await import('../api/agent.js')).default;
const ag = (b) => call(agent, { token: 'agent_test_tok', ...b });

KV.clear(); stripeSubs = []; stripeCustomers = [];
KV.set('ks:leads', JSON.stringify([
  { id: 'A', name: "Charlie's Brake & Muffler", trade: 'auto repair', phone: '(913) 859-9994', city: 'Lenexa', state: 'KS' },
  { id: 'B', name: 'Paying Shop', trade: 'bakery', phone: '816-111-2222', city: 'KC', state: 'MO' },
]));
KV.set('ks:leadmeta', { A: JSON.stringify({ siteSlug: 'charlies-brake-muffler' }), B: JSON.stringify({ siteSlug: 'paying-shop' }) });
putSite({ slug: 'charlies-brake-muffler', business: "Charlie's Brake & Muffler", city: 'Lenexa', trade: 'auto repair', leadId: 'A', published: false, claimed: false, modules: ['P0'] });
putSite({ slug: 'paying-shop', business: 'Paying Shop', city: 'KC', email: EMAIL, leadId: 'B', published: true, claimed: true, modules: ['P0'] });
KV.set('ks:accounts', JSON.stringify({ [EMAIL]: { email: EMAIL, tokenNonce: NONCE, name: 'Pat', stripeCustomerId: 'cus_paid' } }));
stripeSubs = [{ id: 's1', status: 'active', cancel_at_period_end: false, current_period_end: 9999999999,
  items: { data: [{ id: 'i1', price: { id: P11, recurring: { interval: 'month' }, unit_amount: 9900 }, current_period_end: 9999999999 }] } }];

r = await call(agent, { action: 'whoami', phone: '913-859-9994' });
check('a stolen agent token is useless', r.code === 401, 'got ' + r.code);

r = await ag({ action: 'whoami', phone: '+1 (913) 859-9994' });
check('it knows a postcard caller before it speaks', r.body.kind === 'has_site_built' && r.body.business.includes('Charlie'), JSON.stringify({ k: r.body.kind, b: r.body.business }));
check('and that their site is not live yet', r.body.site && r.body.site.published === false);
check('phone formats do not matter', r.body.leadId === 'A');

r = await ag({ action: 'whoami', phone: '816-111-2222' });
check('it knows a paying customer', r.body.kind === 'customer' && r.body.customer.name === 'Pat', JSON.stringify(r.body.kind));
check('and that their plan covers hand edits', r.body.customer.canRequestChanges === true, JSON.stringify(r.body.customer));

r = await ag({ action: 'whoami', phone: '555-000-9999' });
check('a stranger is a stranger', r.body.kind === 'unknown');

r = await ag({ action: 'find_business', name: 'charlie', city: 'lenexa' });
check('it finds them by name when they call from a cell', r.body.count === 1 && r.body.matches[0].slug === 'charlies-brake-muffler', JSON.stringify(r.body));

r = await ag({ action: 'publish_site', slug: 'charlies-brake-muffler', phone: '913-859-9994' });
check('it delivers the site on the call', r.code === 200 && r.body.url.endsWith('/s/charlies-brake-muffler'), JSON.stringify(r.body));
check('the site is now live', (await getSite('charlies-brake-muffler')).published === true);
check('but STILL not indexable', (await getSite('charlies-brake-muffler')).claimed === false);
check('the lead records what happened', JSON.parse((KV.get('ks:leadmeta')).A).stage === 'responded');

r = await ag({ action: 'publish_site', slug: 'no-such-shop' });
check('it cannot invent a site', r.code === 404);

r = await ag({ action: 'create_lead', name: 'Brand New Cafe', trade: 'cafe/coffee', phone: '816-777-8888', city: 'KC', notes: 'saw the postcard' });
check('a cold caller becomes a lead', r.code === 200 && !!r.body.id, JSON.stringify(r.body));
check('and lands on the call board', JSON.parse(KV.get('ks:leads')).some((l) => l.name === 'Brand New Cafe'));
r = await ag({ action: 'create_lead', name: 'Dupe', phone: '816-777-8888' });
check('calling twice does not duplicate them', r.body.duplicate === true, JSON.stringify(r.body));

r = await ag({ action: 'handoff' });
check('it can hand off to a human', r.body.phone === '913-948-3747' && r.body.sip.includes('9139483747'), JSON.stringify(r.body));

r = await ag({ action: 'log_call', phone: '913-859-9994', notes: 'wants photos added', stage: 'won' });
check('it writes the outcome to the board', r.body.meta.stage === 'won' && r.body.meta.notes === 'wants photos added', JSON.stringify(r.body.meta));

r = await ag({ action: 'switch_on_billing', slug: 'paying-shop' });
check('there is no tool that can touch billing', r.code === 400, 'got ' + r.code);

// ---------------------------------------------------------------------------
console.log('\n8. The call becomes a customer');

// what the OWNER says goes straight on. what SEARCH found does not.
r = await ag({ action: 'update_site', slug: 'charlies-brake-muffler',
  confirmed: { about: 'Brakes and exhaust since 2009.', hours: [{ d: 'Mon to Fri', h: '8am to 6pm' }] },
  proposed: { services: ['Transmission rebuilds'], phone: '913-000-0000' },
  proposedNote: 'from a web listing' });
check('what the owner says lands on the site', r.code === 200 && r.body.updated.includes('about'), JSON.stringify(r.body));
let cb = await getSite('charlies-brake-muffler');
check('their words are live', cb.about === 'Brakes and exhaust since 2009.' && cb.hours.length === 1);
check('what search found is NOT live', cb.phone !== '913-000-0000' && !cb.services.some((s) => s.name === 'Transmission rebuilds'),
  JSON.stringify({ ph: cb.phone, svc: cb.services.map((s) => s.name) }));
check('it waits for a human instead', Object.keys(cb.proposed).sort().join(',') === 'phone,services', JSON.stringify(cb.proposed));
check('and says where it came from', cb.proposedNote === 'from a web listing');

r = await asAdmin({ action: 'site-list', q: 'charlie' });
check('/master flags that something is pending', r.body.sites.some((s) => s.hasProposed), JSON.stringify(r.body.sites.map((s) => s.hasProposed)));

r = await asAdmin({ action: 'site-proposed-resolve', slug: 'charlies-brake-muffler', approve: true, fields: ['services'] });
check('approving one field applies only that one', r.body.applied.join() === 'services', JSON.stringify(r.body.applied));
cb = await getSite('charlies-brake-muffler');
check('the approved field is now live', cb.services.length === 1 && cb.services[0].name === 'Transmission rebuilds', JSON.stringify(cb.services));
check('the rejected one never landed', cb.phone !== '913-000-0000', 'phone=' + JSON.stringify(cb.phone));
check('nothing is left pending', Object.keys(cb.proposed).length === 0);

// the close
r = await ag({ action: 'deliver_site', slug: 'charlies-brake-muffler', email: 'not-an-email', phone: '913-859-9994' });
check('a misheard email is refused', r.code === 400 && r.body.error === 'bad_email', JSON.stringify(r.body));

r = await ag({ action: 'deliver_site', slug: 'charlies-brake-muffler', email: 'Charlie@Brakes.com ', name: 'Charlie', phone: '913-859-9994' });
check('saying yes on the phone delivers the site', r.code === 200 && r.body.url.endsWith('/s/charlies-brake-muffler'), JSON.stringify(r.body));
cb = await getSite('charlies-brake-muffler');
check('the email is theirs now, normalised', cb.email === 'charlie@brakes.com', cb.email);
check('the site is live AND claimed, so it can be indexed', cb.published === true && cb.claimed === true);
check('an account exists for them', !!JSON.parse(KV.get('ks:accounts'))['charlie@brakes.com']);
check('the lead is marked won', JSON.parse((KV.get('ks:leadmeta')).A).stage === 'won', KV.get('ks:leadmeta').A);

// ---------------------------------------------------------------------------
console.log('\n9. A site per business, not a template with fields');
process.env.ANTHROPIC_API_KEY = 'ant_stub';
KV.clear(); anthropicCalls.length = 0; siteWriterReply = null;
putSite({ slug: 'test-shop', business: 'Test Shop', trade: 'auto repair', phone: '816-555-0101',
  city: 'Lenexa', state: 'KS', published: true, claimed: false, modules: ['P0'] });

r = await asAdmin({ action: 'site-write', slug: 'test-shop' });
check('it writes a page for this business', r.code === 200 && r.body.bytes > 800, JSON.stringify(r.body));
const sentPrompt = anthropicCalls.find((c) => c.model === 'claude-opus-5');
check('it uses claude-opus-5', !!sentPrompt);
check('the brief carries only facts we hold',
  sentPrompt.messages[0].content.includes('816-555-0101') && !/founded|since \d{4}|award/i.test(sentPrompt.messages[0].content));
check('and forbids inventing the rest', sentPrompt.system.includes('does not go on the page'));

[rq, rs] = mkq('test-shop'); await siteApi(rq, rs);
check('/s/ serves the written page, not the template', rs.code === 200 && rs.body.includes('Georgia,serif'), rs.body.slice(0, 60));
check('an unclaimed business is STILL noindex', rs.body.includes('name="robots" content="noindex'));

// claiming flips indexability without regenerating anything
await upsertSiteFn({ slug: 'test-shop', claimed: true });
[rq, rs] = mkq('test-shop'); await siteApi(rq, rs);
check('claiming makes the same stored page indexable', !rs.body.includes('noindex'));
check('and it is still their written page', rs.body.includes('Georgia,serif'));

// a bad generation must never reach a customer
siteWriterReply = { stop_reason: 'end_turn', content: [{ type: 'text', text: '<!DOCTYPE html><html><head><title>x</title></head><body><img src="https://cdn.example.com/hero.jpg">' + 'y'.repeat(900) + '</body></html>' }] };
r = await asAdmin({ action: 'site-write', slug: 'test-shop' });
check('a page needing the network is rejected', r.code === 502 && /external resource/.test(r.body.message), JSON.stringify(r.body));
siteWriterReply = { stop_reason: 'refusal', content: [] };
r = await asAdmin({ action: 'site-write', slug: 'test-shop' });
check('a refusal is handled, not treated as a page', r.code === 502 && /declined/.test(r.body.message), JSON.stringify(r.body));
[rq, rs] = mkq('test-shop'); await siteApi(rq, rs);
check('the good page survived both failures', rs.body.includes('Georgia,serif'));

siteWriterReply = null;
r = await asAdmin({ action: 'site-unwrite', slug: 'test-shop' });
[rq, rs] = mkq('test-shop'); await siteApi(rq, rs);
check('dropping it falls back to the shared template', rs.code === 200 && !rs.body.includes('Georgia,serif') && rs.body.includes('Test Shop'));

// ---------------------------------------------------------------------------
console.log('\n10. Placeholder sites are the target, not a disqualification');
const { classify, hookLine, segment: segmentFn } = await import('../lib/web-presence.js');
const { draftFromLead } = await import('../lib/draft-site.js');

check('no website at all is still a target', classify('').status === 'none' && classify('').isTarget);
check('a Yelp page is a target', classify('https://www.yelp.com/biz/daves-auto').status === 'directory_only');
check('a Facebook page is a target', classify('https://facebook.com/davesauto').status === 'facebook_only');
check('a NAPA directory page is a target (your #1 lead)', classify('https://www.napaautocare.com/loc/12345').status === 'directory_only');
check('an abandoned Wix is a target (your #7 lead)', classify('https://daves.wixsite.com/auto').status === 'diy_builder');
check('a real site is NOT a target', classify('https://davesautorepair.com').status === 'has_site' && !classify('https://davesautorepair.com').isTarget);
check('www and case do not fool it', classify('HTTPS://WWW.Yelp.com/biz/x').status === 'directory_only');
check('a subdomain of a real site is still their own', classify('https://shop.davesauto.com').status === 'has_site');
check('only their own DIY site is safe to fetch',
  FETCHABLE_CHECK(), 'diy_builder only');
function FETCHABLE_CHECK() {
  return classify('https://x.wixsite.com/y').status === 'diy_builder'
    && classify('https://yelp.com/biz/x').status !== 'diy_builder';
}

check('the hook line states what is true, not a claim',
  hookLine({ web_url: 'https://facebook.com/x', rating: 4.9, reviews_count: 34 })
    === '4.9 stars from 34 reviews, and your whole website is a Facebook page',
  hookLine({ web_url: 'https://facebook.com/x', rating: 4.9, reviews_count: 34 }));
check('thin reputation is left out rather than spun',
  hookLine({ web_url: '', rating: 3.1, reviews_count: 4 }) === 'no website at all');

// the facts now reach the draft, split by who said them
const d2 = draftFromLead({
  id: 'Z', name: 'Hours Shop', trade: 'bakery', phone: '816-555-3333', city: 'KC', state: 'MO',
  hours: [{ d: 'Mon to Fri', h: '7am to 3pm' }, { d: 'Sat', h: '8am to noon' }],
  google_summary: 'A neighborhood bakery known for sourdough.',
}, new Set());
// booking widgets listed AS the website, found in the wild in Overland Park
check('a booking page is a placeholder, not a website',
  classify('https://book.gocheckin.net/x').status === 'booking_only'
  && classify('https://booking.galaxyaccess.us/y').status === 'booking_only');
check('and it is a target', classify('https://book.gocheckin.net/x').isTarget);

// segments LABEL, they do not rank
check('9 ratings says nothing either way', segmentFn(3.3, 9) === 'unproven');
check('few ratings but trading = the new/small group', segmentFn(4.4, 22) === 'new_or_small');
check('623 at 4.7 = busy and well rated', segmentFn(4.7, 623) === 'established_strong');
check('200 at 3.1 = a site will not fix it', segmentFn(3.1, 200) === 'reputation_problem');
check('a low rating is never excluded, only labelled',
  ['unproven', 'new_or_small', 'reputation_problem', 'established_mixed', 'established_strong']
    .includes(segmentFn(2.0, 500)));

check('their published hours go live', d2.hours.length === 2 && d2.hours[0].h === '7am to 3pm');
check("Google's description does NOT", d2.about === '' && d2.proposed.about.includes('sourdough'));
check('and it says whose words they are', d2.proposedNote.includes('not the owner'));

// ---------------------------------------------------------------------------
// The retirement GATE, tested on a stand-in rather than on a real product.
//
// P5 and P6 sat behind this gate briefly because they were sold with nothing
// built. They were built instead, so RETIRED is empty and should stay that way.
// The mechanism still has to work, because it is what stops the catalogue
// drifting ahead of the code again, so it is exercised by putting a phase in the
// set for the duration of these checks and taking it straight back out.
console.log('\n11. The retirement gate still works, and confiscates nothing');

const checkout = (await import('../api/checkout.js')).default;
const { RETIRED, isSellable } = await import('../lib/prices.js');
const P5 = 'price_1ToXluPmxnF3rtBMEleF5u3D';  // CRM
const P6 = 'price_1ToXlvPmxnF3rtBM7aDkUq1Y';  // Marketing Automation

check('nothing is retired right now, because everything on sale is built',
  RETIRED.size === 0, [...RETIRED].join(','));
check('and every priced module is therefore sellable',
  ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P11'].every(isSellable));

RETIRED.add('P2');   // stand-in for "sold but not built", for these checks only
try {
  seed();
  r = await call(checkout, { phases: ['P2'], email: 'buyer@example.com' });
  check('the public checkout refuses a retired module',
    r.code === 400 && r.body.error === 'not_for_sale', 'got ' + r.code + ' ' + JSON.stringify(r.body));
  check('and no Stripe session was created for it', created.length === 0, created.length + ' created');

  // The dangerous near-miss: silently dropping the unbuilt item and charging for
  // the rest would take money for a basket the customer never agreed to.
  seed();
  r = await call(checkout, { phases: ['P1', 'P2'], email: 'buyer@example.com' });
  check('a basket containing a retired module is refused whole, not trimmed',
    r.code === 400 && r.body.error === 'not_for_sale' && created.length === 0,
    'got ' + r.code + ', ' + created.length + ' sessions');

  // The panel is the other door into Stripe and had the same hole.
  seed();
  r = await call(switchApi, { action: 'apply', e: EMAIL, t: TOK, on: ['P2'] });
  check('the panel cannot start a retired module either', created.length === 0, created.length + ' created');
  check('and it never reaches their live site', !site().modules.includes('P2'), JSON.stringify(site().modules));

  // Grandfathering. Removing a module from the panel catalogue outright would
  // mean the browser stopped sending it, and the server reads that absence as
  // "turn it off": a paying customer silently loses what they bought.
  const P2P = 'price_1ToXlrPmxnF3rtBMz3ybz47E';
  function seedPaid() {
    seed();
    KV.set('ks:accounts', JSON.stringify({ [EMAIL]: { email: EMAIL, tokenNonce: NONCE, name: 'Test Shop', plan: ['P0'], stripeCustomerId: 'cus_old' } }));
    putSite({ slug: 'test-shop', business: 'Test Shop', email: EMAIL, phone: '816-555-0101', modules: ['P0', 'P2'], published: true, claimed: true });
    stripeSubs = [{
      id: 'sub_1', status: 'active', cancel_at_period_end: false, current_period_end: 9999999999,
      items: { data: [{ id: 'si_p2', price: { id: P2P }, current_period_end: 9999999999 }] },
    }];
  }

  seedPaid();
  r = await call(switchApi, { action: 'state', e: EMAIL, t: TOK });
  check('someone who already bought it still sees it in their panel',
    r.body.modules && r.body.modules.P2 && r.body.modules.P2.state === 'active', JSON.stringify(r.body.modules));

  seedPaid();
  r = await call(switchApi, { action: 'apply', e: EMAIL, t: TOK, on: ['P2'] });
  check('saving the panel does not confiscate what they already pay for',
    r.body.modules && r.body.modules.P2 && r.body.modules.P2.state === 'active', JSON.stringify(r.body));
  check('and it stays on their site', site().modules.includes('P2'), JSON.stringify(site().modules));

  seedPaid();
  r = await call(switchApi, { action: 'apply', e: EMAIL, t: TOK, on: [] });
  check('but they can still switch it off themselves',
    r.body.modules && r.body.modules.P2 && r.body.modules.P2.state === 'ending', JSON.stringify(r.body));
} finally {
  RETIRED.delete('P2');
}

// Both are back on sale because both now do something. This is the check that
// fails if anyone re-lists a module without building it.
seed();
r = await call(checkout, { phases: ['P5', 'P6'], email: 'buyer@example.com' });
check('CRM and automation can be bought again, now that they exist',
  r.code === 200 && !!r.body.url, 'got ' + r.code + ' ' + JSON.stringify(r.body));

const chatSrc = await (await import('node:fs/promises')).readFile(path.join(ROOT, 'api/chat.js'), 'utf8');
check('the bot sells them again', /P5 CRM/.test(chatSrc) && /P6 Marketing Automation/.test(chatSrc));
check('but is told how narrow they are', /not a pipeline/.test(chatSrc) && /no texts/i.test(chatSrc));

// ---------------------------------------------------------------------------
// The public pricing page used to charge a card and provision nothing: no
// account, no panel, no modules switched on, nobody told, and no webhook to
// catch it later. These check that a purchase there now lands somewhere.
console.log('\n12. Buying from the pricing page actually provisions something');

const NEW = 'walkin@example.com';

seed();
r = await call(checkout, { phases: ['P1'] });
check('no email, no sale', r.code === 400 && r.body.error === 'email_required', 'got ' + r.code + ' ' + JSON.stringify(r.body));
check('and nothing was charged', created.length === 0);

seed();
r = await call(checkout, { phases: ['P1'], email: 'not-an-address' });
check('a malformed email is refused too', r.code === 400 && r.body.error === 'email_required');

seed();
r = await call(checkout, { phases: ['P1', 'P3'], email: NEW });
check('a real purchase opens checkout', r.code === 200 && !!r.body.url, JSON.stringify(r.body));

const accounts = () => JSON.parse(KV.get('ks:accounts'));
check('an account exists BEFORE they pay, so the money has somewhere to land',
  !!accounts()[NEW], Object.keys(accounts()).join(','));

const sess = decodeURIComponent(created[0] || '');
check('they come back to their own panel, not a static thank-you page',
  /success_url=[^&]*\/panel\?e=/.test(sess) && !sess.includes('/pricing?checkout=success'), sess.slice(0, 220));
check('and it carries the session id that triggers linking',
  sess.includes('session_id={CHECKOUT_SESSION_ID}'), sess.slice(0, 260));
check('Stripe is told who is buying', sess.includes('customer_email=' + NEW) || sess.includes('customer_email=walkin'), sess.slice(0, 200));

// An existing customer must not be reset to a free plan by buying an upgrade,
// and must not end up with a second Stripe customer object.
seed();
KV.set('ks:accounts', JSON.stringify({ [EMAIL]: { email: EMAIL, tokenNonce: NONCE, name: 'Test Shop', plan: ['P0', 'P3'], stripeCustomerId: 'cus_old' } }));
r = await call(checkout, { phases: ['P1'], email: EMAIL });
check('an existing customer keeps their record', accounts()[EMAIL].name === 'Test Shop'
  && accounts()[EMAIL].plan.includes('P3'), JSON.stringify(accounts()[EMAIL]));
check('and reuses their Stripe customer instead of making a second one',
  decodeURIComponent(created[0] || '').includes('customer=cus_old'), decodeURIComponent(created[0] || '').slice(0, 200));

// Basket first, email second, and no account created for a refused sale.
RETIRED.add('P2');
try {
  seed();
  r = await call(checkout, { phases: ['P2'], email: NEW });
  check('a retired module is refused even with a valid email',
    r.code === 400 && r.body.error === 'not_for_sale' && created.length === 0);
  check('and a refused sale leaves no half-made account behind',
    !accounts()[NEW], Object.keys(accounts()).join(','));
} finally {
  RETIRED.delete('P2');
}

// ---------------------------------------------------------------------------
// "Contact form" has always been listed under the free tier and the template had
// none: the only two forms were booking (P3) and the AI widget (P9), both paid.
// A free customer's finished site could not be messaged at all.
console.log('\n13. The free site can actually be contacted');

// renderSite is already imported above; only these two are new here.
const siteAction = (await import('../api/site-action.js')).default;
const { SITE_DEFAULT } = await import('../lib/sites.js');

const freeSite = {
  ...SITE_DEFAULT, slug: 'free-shop', business: 'Free Shop', phone: '816-555-0101',
  services: [{ name: 'Repairs' }], modules: ['P0'], published: true, claimed: true,
};
const freeHtml = renderSite(freeSite);
check('a free site renders a contact form', freeHtml.includes('ksContact'));
check('and still gets no paid booking form', !freeHtml.includes('id="book"'));
check('and still gets no paid AI widget', !freeHtml.includes('aiBtn'));

seed();
putSite({ ...freeSite, email: EMAIL });
r = await call(siteAction, { action: 'contact', slug: 'free-shop', name: 'Jo', contact: '816-555-9999', message: 'Do you do brakes?' });
check('a visitor message on a FREE site is accepted', r.code === 200 && r.body.ok, 'got ' + r.code + ' ' + JSON.stringify(r.body));

// The contrast that proves it is genuinely ungated: the SAME free site still
// cannot take a booking, because booking is paid and contact is not.
r = await call(siteAction, { action: 'book', slug: 'free-shop', name: 'Jo', phone: '816-555-9999', when: 'Tue' });
check('while booking on that same free site is still refused',
  r.code === 403 && r.body.error === 'module_off', 'got ' + r.code + ' ' + JSON.stringify(r.body));

seed();
putSite({ ...freeSite, email: EMAIL });
r = await call(siteAction, { action: 'contact', slug: 'free-shop', name: 'Jo', contact: 'x', message: '' });
check('an empty message is refused', r.code === 400, 'got ' + r.code);

// The honeypot answers 200 so a bot learns nothing from being caught. Proving
// it actually short-circuits rather than just happening to succeed: the same
// submission with a REQUIRED FIELD MISSING still returns 200, which can only
// happen if the honeypot returned before validation ran.
seed();
putSite({ ...freeSite, email: EMAIL });
r = await call(siteAction, { action: 'contact', slug: 'free-shop', name: 'Bot', contact: '', message: '', website: 'http://spam' });
check('a bot filling the honeypot is dropped before anything is sent',
  r.code === 200 && r.body.ok, 'got ' + r.code + ' ' + JSON.stringify(r.body));

// An unpublished site is still a hard 404 on this path, same as booking.
seed();
putSite({ ...freeSite, email: EMAIL, published: false });
r = await call(siteAction, { action: 'contact', slug: 'free-shop', name: 'Jo', contact: 'x', message: 'hi' });
check('an unpublished site cannot be messaged', r.code === 404, 'got ' + r.code);

// ---------------------------------------------------------------------------
// P8 was $19/mo for "a plain-English monthly report" and delivered a script
// whose data went to OUR dashboard. The customer had no screen and no number.
console.log('\n14. Analytics shows the customer their own number');

const { recordView, getStats } = await import('../lib/stats.js');
const sitemapSites = (await import('../api/sitemap-sites.js')).default;

const P8 = 'price_1ToXlyPmxnF3rtBMendZWgMs';
const paidSite = { ...freeSite, email: EMAIL, modules: ['P0', 'P8'] };

seed();
putSite(paidSite);
r = await call(siteAction, { action: 'view', slug: 'free-shop' });
check('a view on a paid site is counted', r.code === 204, 'got ' + r.code);

seed();
putSite({ ...freeSite, email: EMAIL, modules: ['P0'] });
r = await call(siteAction, { action: 'view', slug: 'free-shop' });
check('a view on a site NOT paying for it is refused',
  r.code === 403 && r.body.error === 'module_off', 'got ' + r.code);

// Counting, over three days, read back the way the panel reads it.
seed();
const day1 = new Date('2026-08-08T12:00:00Z'), day2 = new Date('2026-08-09T12:00:00Z'), day3 = new Date('2026-08-10T12:00:00Z');
await recordView('free-shop', day1);
await recordView('free-shop', day2);
await recordView('free-shop', day2);
await recordView('free-shop', day3);
const st = await getStats('free-shop', day3);
check('all time counts every view', st.allTime === 4, JSON.stringify(st.allTime));
check('this month is separate from all time', st.thisMonth === 4, JSON.stringify(st.thisMonth));
check('the 30 day series is 30 long', st.series.length === 30, String(st.series.length));
check('and puts the two views on the right day',
  st.series[st.series.length - 2].views === 2, JSON.stringify(st.series.slice(-3)));
check('a site nobody has visited reads zero, not null',
  (await getStats('never-seen', day3)).allTime === 0);

// The panel only gets numbers if Stripe says they are paying, so switching P8
// off stops the data with the billing rather than leaving it running.
seed();
putSite(paidSite);
KV.set('ks:accounts', JSON.stringify({ [EMAIL]: { email: EMAIL, tokenNonce: NONCE, name: 'Test Shop', stripeCustomerId: 'cus_a' } }));
stripeSubs = [{ id: 'sub_1', status: 'active', cancel_at_period_end: false, current_period_end: 9999999999,
  items: { data: [{ id: 'si_p8', price: { id: P8 }, current_period_end: 9999999999 }] } }];
r = await call(switchApi, { action: 'stats', e: EMAIL, t: TOK });
check('a paying customer gets their numbers', r.code === 200 && r.body.entitled === true && !!r.body.stats, JSON.stringify(r.body).slice(0, 160));

seed();
putSite(paidSite);
r = await call(switchApi, { action: 'stats', e: EMAIL, t: TOK });
check('a customer not paying for it gets nothing', r.body.entitled === false, JSON.stringify(r.body));

// ---- the sitemap P1 now promises ----
console.log('\n15. Customer sites are actually submitted to Google');

function mkxml() {
  const r = { code: 0, body: '', headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.send = (b) => { r.body = b; return r; };
  return r;
}
const getXml = async () => { const res = mkxml(); await sitemapSites({ method: 'GET', headers: { host: 'test.local' } }, res); return res; };

seed();
putSite({ ...freeSite, slug: 'claimed-shop', business: 'Claimed', published: true, claimed: true });
putSite({ ...freeSite, slug: 'draft-shop', business: 'Draft', published: true, claimed: false });
putSite({ ...freeSite, slug: 'hidden-shop', business: 'Hidden', published: false, claimed: false });
let x = await getXml();
check('the sitemap is valid xml', x.code === 200 && x.body.startsWith('<?xml'), x.body.slice(0, 60));
check('a claimed site is submitted', x.body.includes('/s/claimed-shop'), x.body);
// The important one: a site built for a business that has agreed to nothing
// must never be handed to Google, which is the whole point of `claimed`.
check('a published-but-unclaimed draft is NOT submitted', !x.body.includes('/s/draft-shop'), x.body);
check('an unpublished site is not submitted', !x.body.includes('/s/hidden-shop'), x.body);
check('it is served as xml', String(x.headers['content-type']).includes('xml'), x.headers['content-type']);

seed();
x = await getXml();
check('no customers yet still yields a valid empty sitemap',
  x.code === 200 && x.body.includes('<urlset') && x.body.includes('</urlset>'), x.body);

// ---------------------------------------------------------------------------
// P5 and P6, the two that were sold with nothing behind them. Built, not cut.
console.log('\n16. The CRM keeps people, and the automation follows them up');

const { recordContact, listContacts, updateContact, summarise } = await import('../lib/crm.js');
const { queueFollowUps, dueItems, retire, bodyFor, statsFor } = await import('../lib/automation.js');
const P5P = 'price_1ToXluPmxnF3rtBMEleF5u3D';

const crmSite = { ...freeSite, email: EMAIL, modules: ['P0', 'P5', 'P6'] };

// The whole point of P5: an enquiry in March and a booking in June are ONE
// customer with a history, not two emails that scrolled away.
seed();
await recordContact('free-shop', { name: 'Dana Reed', handle: 'dana@example.com', kind: 'message', text: 'Do you do brakes?', at: '2026-03-01T10:00:00Z' });
await recordContact('free-shop', { name: 'Dana Reed', handle: 'dana@example.com', kind: 'booking', text: 'Tuesday 9am', at: '2026-06-01T10:00:00Z' });
let cs = await listContacts('free-shop');
check('two enquiries from one person make ONE contact', cs.length === 1, JSON.stringify(cs.length));
check('and both are kept as history', cs[0].entries.length === 2, JSON.stringify(cs[0].entries));
check('the email is picked out so they can be replied to', cs[0].email === 'dana@example.com');
check('a new contact starts as needing a reply', cs[0].status === 'new');

await recordContact('free-shop', { name: 'Sam', handle: '816-555-2222', kind: 'message', text: 'quote please', at: '2026-06-02T10:00:00Z' });
cs = await listContacts('free-shop');
check('a different person is a different contact', cs.length === 2);
check('a phone number is stored as a phone, not an email',
  cs.find((c) => c.name === 'Sam').phone === '816-555-2222');
check('newest first, so the panel opens on what just came in', cs[0].name === 'Sam', cs.map((c) => c.name).join(','));

await updateContact('free-shop', cs[0].id, { status: 'won' });
cs = await listContacts('free-shop');
check('the owner can mark someone won', cs.find((c) => c.name === 'Sam').status === 'won');
check('and the counts follow', summarise(cs).won === 1 && summarise(cs).new === 1, JSON.stringify(summarise(cs)));
check('an invented status is refused', (await updateContact('free-shop', cs[0].id, { status: 'banana' })) === null);

// It has to be reachable from the panel, gated on Stripe like everything else.
seed();
putSite(crmSite);
KV.set('ks:accounts', JSON.stringify({ [EMAIL]: { email: EMAIL, tokenNonce: NONCE, name: 'Test Shop', stripeCustomerId: 'cus_a' } }));
stripeSubs = [{ id: 'sub_1', status: 'active', cancel_at_period_end: false, current_period_end: 9999999999,
  items: { data: [{ id: 'si_p5', price: { id: P5P }, current_period_end: 9999999999 }] } }];
await recordContact('free-shop', { name: 'Dana', handle: 'dana@example.com', kind: 'message', text: 'hi', at: '2026-06-01T10:00:00Z' });
r = await call(switchApi, { action: 'crm', e: EMAIL, t: TOK });
check('a paying customer sees their list', r.body.entitled === true && r.body.contacts.length === 1, JSON.stringify(r.body).slice(0, 140));

seed();
putSite(crmSite);
r = await call(switchApi, { action: 'crm', e: EMAIL, t: TOK });
check('someone not paying for it sees nothing', r.body.entitled === false, JSON.stringify(r.body));
r = await call(switchApi, { action: 'crm-update', e: EMAIL, t: TOK, id: 'x', status: 'won' });
check('and cannot write to it either', r.body.error === 'not_entitled', JSON.stringify(r.body));

// ---- P6 ----
const T0 = Date.parse('2026-06-01T10:00:00Z');
seed();
let n = await queueFollowUps({ slug: 'free-shop', business: "Jo's Garage", phone: '816-555-0101' },
  { name: 'Dana Reed', handle: 'dana@example.com', kind: 'message' }, T0);
check('an enquiry queues both follow-ups', n === 2, String(n));

let due = await dueItems(T0);
check('the thank-you is due immediately', due.length === 1 && due[0].step === 'ack', JSON.stringify(due.map((d) => d.step)));
check('the review request is NOT sent early', !due.some((d) => d.step === 'review'));

due = await dueItems(T0 + 3 * 86400000);
check('and IS due three days later', due.some((d) => d.step === 'review'), JSON.stringify(due.map((d) => d.step)));

// No email address means nothing to send to, and we do not send texts.
seed();
n = await queueFollowUps({ slug: 'free-shop', business: 'X' }, { name: 'Sam', handle: '816-555-2222', kind: 'message' }, T0);
check('a phone-only enquiry queues nothing, because we do not send texts', n === 0, String(n));

// A second enquiry must not stack a second review request on the same person.
seed();
await queueFollowUps({ slug: 'free-shop', business: 'X' }, { name: 'D', handle: 'd@e.com', kind: 'message' }, T0);
await queueFollowUps({ slug: 'free-shop', business: 'X' }, { name: 'D', handle: 'd@e.com', kind: 'booking' }, T0 + 3600000);
due = await dueItems(T0 + 10 * 86400000);
check('a repeat enquiry does not double up on the same person', due.length === 2, JSON.stringify(due.map((d) => d.id)));

const ack = bodyFor({ step: 'ack', name: 'Dana Reed', business: "Jo's Garage", kind: 'booking', businessPhone: '816-555-0101' });
check('the thank-you names the business, not us', ack.lines.join(' ').includes("Jo's Garage"));
check('and knows it was a booking', ack.lines.join(' ').toLowerCase().includes('book'));
const rev = bodyFor({ step: 'review', name: 'Dana Reed', business: "Jo's Garage" });
check('the review request asks for a review', rev.subject.toLowerCase().includes('how did we do'));
check('and offers a way out if it went badly', rev.lines.join(' ').toLowerCase().includes('not right'));

seed();
await queueFollowUps({ slug: 'free-shop', business: 'X' }, { name: 'D', handle: 'd@e.com', kind: 'message' }, T0);
let st2 = await statsFor('free-shop');
check('the panel can see what is queued', st2.pending === 2, JSON.stringify(st2));
due = await dueItems(T0);
await retire(due[0].id, '2026-06-01T10:00:01Z');
st2 = await statsFor('free-shop');
check('and what has already gone out', st2.sent === 1 && st2.pending === 1, JSON.stringify(st2));

// The end to end path: a message on a live site lands in the CRM and queues mail.
seed();
putSite(crmSite);
r = await call(siteAction, { action: 'contact', slug: 'free-shop', name: 'Pat', contact: 'pat@example.com', message: 'Do you fit tyres?' });
check('a real enquiry through the site is accepted', r.code === 200);
await new Promise((res) => setTimeout(res, 40));   // the writes are fire and forget
cs = await listContacts('free-shop');
check('and it lands in the customer list by itself', cs.length === 1 && cs[0].name === 'Pat', JSON.stringify(cs.map((c) => c.name)));
check('with its follow-ups queued', (await statsFor('free-shop')).pending === 2, JSON.stringify(await statsFor('free-shop')));

// A site NOT paying for them records nothing, so switching off really stops it.
seed();
putSite({ ...freeSite, email: EMAIL, modules: ['P0'] });
r = await call(siteAction, { action: 'contact', slug: 'free-shop', name: 'Pat', contact: 'pat@example.com', message: 'hello' });
await new Promise((res) => setTimeout(res, 40));
check('no CRM record without P5', (await listContacts('free-shop')).length === 0);
check('no follow-ups queued without P6', (await statsFor('free-shop')).pending === 0);

// ---------------------------------------------------------------------------
// The webhook: the ear that makes a no-code payment link provision itself.
// Nothing existing changed, so these are all NEW behaviours on a NEW endpoint.
console.log('\n17. A payment through ANY door now sets the customer up');

const crypto2 = await import('node:crypto');
const { verifySignature } = await import('../api/stripe-webhook.js');
const webhook = (await import('../api/stripe-webhook.js')).default;

const WHSEC = 'whsec_test_secret';
function signed(payload, secret = WHSEC, t = Math.floor(Date.now() / 1000)) {
  const body = Buffer.from(JSON.stringify(payload));
  const sig = crypto2.createHmac('sha256', secret).update(t + '.' + body.toString('utf8'), 'utf8').digest('hex');
  return { body, header: `t=${t},v1=${sig}` };
}

// A fake request that streams the raw bytes, because the signature is over them.
function rawReq(body, header) {
  const listeners = {};
  const req = {
    method: 'POST',
    headers: { 'stripe-signature': header, host: 'test.local' },
    on(ev, fn) { listeners[ev] = fn; return req; },
  };
  setTimeout(() => { if (listeners.data) listeners.data(body); if (listeners.end) listeners.end(); }, 0);
  return req;
}
const hook = async (payload, { secret = WHSEC, tamper = false, t } = {}) => {
  const { body, header } = signed(payload, secret, t);
  const res = mkres();
  await webhook(rawReq(tamper ? Buffer.from(body.toString('utf8') + ' ') : body, header), res);
  return res;
};

// ---- signature, checked directly ----
const p1 = signed({ hello: 'world' });
check('a correct signature verifies', verifySignature(p1.body, p1.header, WHSEC));
check('the wrong secret does not', !verifySignature(p1.body, p1.header, 'whsec_other'));
check('a tampered body does not', !verifySignature(Buffer.from('{"hello":"evil"}'), p1.header, WHSEC));
check('no signature header does not', !verifySignature(p1.body, '', WHSEC));
const old = signed({ hello: 'world' }, WHSEC, Math.floor(Date.now() / 1000) - 4000);
check('a replayed event from an hour ago is refused', !verifySignature(old.body, old.header, WHSEC));

// ---- the endpoint refuses anything it cannot verify ----
process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
seed();
let w = await hook({ type: 'checkout.session.completed', data: { object: {} } }, { secret: 'whsec_wrong' });
check('the endpoint rejects a forged event', w.code === 400, 'got ' + w.code);

seed();
w = await hook({ type: 'checkout.session.completed', data: { object: {} } }, { tamper: true });
check('and a tampered body', w.code === 400, 'got ' + w.code);

delete process.env.STRIPE_WEBHOOK_SECRET;
seed();
w = await hook({ type: 'checkout.session.completed', data: { object: {} } });
check('with no secret configured it fails CLOSED, not open', w.code === 503, 'got ' + w.code);
process.env.STRIPE_WEBHOOK_SECRET = WHSEC;

// ---- the payload that matters: someone bought through a payment link ----
const LINKBUYER = 'linkbuyer@example.com';
const P9P = 'price_1ToXlzPmxnF3rtBMv1DlSFC5';

seed();
putSite({ slug: 'link-shop', business: 'Link Shop', email: LINKBUYER, modules: ['P0'], published: true, claimed: true });
stripeSubs = [{ id: 'sub_link', status: 'active', cancel_at_period_end: false, current_period_end: 9999999999,
  items: { data: [{ id: 'si_p9', price: { id: P9P }, current_period_end: 9999999999 }] } }];
w = await hook({
  type: 'checkout.session.completed', id: 'evt_1',
  data: { object: { customer: 'cus_link', customer_details: { email: LINKBUYER }, amount_total: 2900 } },
});
check('a link purchase is accepted', w.code === 200, 'got ' + w.code);

const accts = () => JSON.parse(KV.get('ks:accounts'));
check('an account is created for someone who never touched our site',
  !!accts()[LINKBUYER], Object.keys(accts()).join(','));
check('and their Stripe customer is attached',
  accts()[LINKBUYER].stripeCustomerId === 'cus_link', JSON.stringify(accts()[LINKBUYER]));
const linkSite = () => JSON.parse(KV.get('ks:site:link-shop'));
check('what they paid for is switched ON for their site',
  linkSite().modules.includes('P9'), JSON.stringify(linkSite().modules));

// The case that used to vanish entirely: a payment link that collected no email.
seed();
w = await hook({ type: 'checkout.session.completed', data: { object: { customer: 'cus_x', amount_total: 1900 } } });
check('a payment with no email still returns 200 rather than retrying forever', w.code === 200);
check('and creates no junk account', Object.keys(accts()).length === 1, Object.keys(accts()).join(','));

// An existing customer must not be reset by a second purchase.
seed();
KV.set('ks:accounts', JSON.stringify({ [EMAIL]: { email: EMAIL, tokenNonce: NONCE, name: 'Test Shop', plan: ['P0', 'P3'], stripeCustomerId: 'cus_old' } }));
stripeSubs = [];
w = await hook({ type: 'checkout.session.completed', data: { object: { customer: 'cus_old', customer_details: { email: EMAIL }, amount_total: 1900 } } });
check('an existing customer keeps their record', accts()[EMAIL].name === 'Test Shop' && accts()[EMAIL].plan.includes('P3'),
  JSON.stringify(accts()[EMAIL]));

// Our own bug must never become a Stripe retry storm.
seed();
w = await hook({ type: 'checkout.session.completed', data: { object: { customer: 12345, customer_details: null } } });
check('a malformed event is acknowledged, not retried for days', w.code === 200, 'got ' + w.code);

seed();
w = await hook({ type: 'customer.discount.created', data: { object: {} } });
check('an event we do not care about is acknowledged quietly', w.code === 200);

// ---------------------------------------------------------------------------
// P4: the two claims that had no code behind them.
console.log('\n18. Daily backups and around-the-clock watching');

const { runBackup, listBackups, restorePreview, checkUptime, lastUptime, stamp } =
  await import('../lib/backup.js');

const DAY0 = new Date('2026-08-10T03:30:00Z');
seed();
putSite({ slug: 'a-shop', business: 'A Shop', email: 'a@x.com', modules: ['P0'], published: true, claimed: true, tagline: 'original' });
putSite({ slug: 'b-shop', business: 'B Shop', email: 'b@x.com', modules: ['P0'], published: true, claimed: true });
let bk = await runBackup(DAY0);
check('a backup snapshots every site', bk.sites === 3, JSON.stringify(bk));
check('and is dated', bk.stamp === '2026-08-10', bk.stamp);
check('it shows up in the list', (await listBackups()).some((b) => b.stamp === '2026-08-10'));

// The point of a backup is getting one customer back, so that is what is tested.
const before = await restorePreview('2026-08-10', 'a-shop');
check('a single site can be read back out of it', before && before.tagline === 'original', JSON.stringify(before));

putSite({ slug: 'a-shop', business: 'A Shop', email: 'a@x.com', modules: ['P0'], published: true, claimed: true, tagline: 'RUINED' });
const after = await restorePreview('2026-08-10', 'a-shop');
check('and still reads the OLD content after the live record is wrecked',
  after && after.tagline === 'original', JSON.stringify(after));

// Running twice in a day must not produce two backups.
await runBackup(DAY0);
check('a second run the same day overwrites rather than duplicating',
  (await listBackups()).filter((b) => b.stamp === '2026-08-10').length === 1);

// ---- uptime ----
seed();
const sites = [{ slug: 'up-shop', business: 'Up Shop', published: true }, { slug: 'down-shop', business: 'Down Shop', published: true }];
const fakeFetch = async (url) => ({ status: url.includes('down-shop') ? 500 : 200 });
let up = await checkUptime('https://test.local', sites, fakeFetch, DAY0);
check('every published site is checked', up.checked === 2, JSON.stringify(up));
check('a broken one is reported', up.failures.length === 1 && up.failures[0].slug === 'down-shop', JSON.stringify(up.failures));
check('a healthy one is not', !up.failures.some((f) => f.slug === 'up-shop'));
check('the result is stored for the next comparison', (await lastUptime()).failures.length === 1);

const deadFetch = async () => { throw new Error('ECONNREFUSED'); };
up = await checkUptime('https://test.local', sites, deadFetch, DAY0);
check('a site that does not respond at all counts as down', up.failures.length === 2, JSON.stringify(up.failures));

const allGood = async () => ({ status: 200 });
up = await checkUptime('https://test.local', sites, allGood, DAY0);
check('and recovery is visible', up.failures.length === 0);

// ---------------------------------------------------------------------------
// "They flip it on, their card is charged. They use it. They flip it off on the
//  2nd, it runs until the 11th, then it stops. No prorating, no refunds."
//
// The billing half was already right. The DELIVERY half was not: switching
// something off stripped it from the live site that same second, so nine days
// they had paid for were not delivered, while the panel promised the opposite.
console.log('\n19. Switch off keeps working until the cycle they paid for ends');

const { sweepExpired } = await import('../lib/backup.js');
const { removeModules } = await import('../lib/sites.js');
const { getAccounts, saveAccounts } = await import('../lib/store.js');

const P1PRICE = 'price_1ToXlLPmxnF3rtBM5NRurfkt';   // Get Found on Google
const P3PRICE = 'price_1ToXlsPmxnF3rtBM9Dc9mDul';   // Online Booking

// Their cycle is paid through the 11th.
const PAID_TO = Math.floor(Date.parse('2026-10-11T00:00:00Z') / 1000);
const ON_THE_2ND = Date.parse('2026-10-02T09:00:00Z');
const ON_THE_12TH = Date.parse('2026-10-12T09:00:00Z');

function seedPaid(prices) {
  seed();
  KV.set('ks:accounts', JSON.stringify({ [EMAIL]: { email: EMAIL, tokenNonce: NONCE, name: 'Test Shop', stripeCustomerId: 'cus_1' } }));
  putSite({ slug: 'test-shop', business: 'Test Shop', email: EMAIL, phone: '816-555-0101',
    modules: ['P0', ...prices.map((p) => (p === P1PRICE ? 'P1' : 'P3'))], published: true, claimed: true });
  stripeSubs = [{ id: 'sub_1', status: 'active', cancel_at_period_end: false, current_period_end: PAID_TO,
    items: { data: prices.map((pr, i) => ({ id: 'si_' + i, price: { id: pr }, current_period_end: PAID_TO })) } }];
}

// ---- one of two modules switched off ----
seedPaid([P1PRICE, P3PRICE]);
r = await call(switchApi, { action: 'apply', e: EMAIL, t: TOK, on: ['P1'] });
check('billing says it ends on the day they are paid to',
  r.body.modules.P3 && r.body.modules.P3.state === 'ending' && r.body.modules.P3.endsAt === PAID_TO,
  JSON.stringify(r.body.modules));
check('and booking is STILL LIVE on their website, because they paid for it',
  site().modules.includes('P3'), JSON.stringify(site().modules));
check('while the module they kept is untouched', site().modules.includes('P1'));

// The day after the cycle ends, the sweep takes it away. Nothing else does.
let sw = await sweepExpired({ getAccounts, saveAccounts, removeModules }, ON_THE_12TH);
check('the sweep finds it once the paid period has passed',
  sw.expired.length === 1 && sw.expired[0].phases.includes('P3'), JSON.stringify(sw.expired));
check('and NOW it comes off their website', !site().modules.includes('P3'), JSON.stringify(site().modules));
check('the module they still pay for survives the sweep', site().modules.includes('P1'), JSON.stringify(site().modules));
check('and the expiry is forgotten, so it cannot fire twice',
  !((await getAccounts())[EMAIL].ending || {}).P3, JSON.stringify((await getAccounts())[EMAIL].ending));

// ---- run it BEFORE the cycle ends: nothing may happen ----
seedPaid([P1PRICE, P3PRICE]);
await call(switchApi, { action: 'apply', e: EMAIL, t: TOK, on: ['P1'] });
sw = await sweepExpired({ getAccounts, saveAccounts, removeModules }, ON_THE_2ND);
check('running the sweep DURING the paid period takes nothing away',
  sw.expired.length === 0 && site().modules.includes('P3'), JSON.stringify(site().modules));

// ---- their last module switched off ----
seedPaid([P1PRICE]);
r = await call(switchApi, { action: 'apply', e: EMAIL, t: TOK, on: [] });
check('cancelling the whole subscription still ends at the paid-to date',
  r.body.modules.P1 && r.body.modules.P1.state === 'ending' && r.body.modules.P1.endsAt === PAID_TO,
  JSON.stringify(r.body.modules));
check('and it stays live until then', site().modules.includes('P1'), JSON.stringify(site().modules));
sw = await sweepExpired({ getAccounts, saveAccounts, removeModules }, ON_THE_12TH);
check('then goes, leaving the free site behind', !site().modules.includes('P1') && site().modules.includes('P0'),
  JSON.stringify(site().modules));

// ---- switching it back on before the cycle ends must not later be swept ----
seedPaid([P1PRICE, P3PRICE]);
await call(switchApi, { action: 'apply', e: EMAIL, t: TOK, on: ['P1'] });           // off
stripeSubs[0].items.data.push({ id: 'si_re', price: { id: P3PRICE }, current_period_end: PAID_TO });
await call(switchApi, { action: 'apply', e: EMAIL, t: TOK, on: ['P1', 'P3'] });     // back on
sw = await sweepExpired({ getAccounts, saveAccounts, removeModules }, ON_THE_12TH);
check('changing their mind and switching it back on cancels the expiry',
  site().modules.includes('P3'), JSON.stringify(site().modules));

// ---- no refunds, ever ----
seedPaid([P1PRICE, P3PRICE]);
const callsBefore = JSON.stringify(stripeSubs);
await call(switchApi, { action: 'apply', e: EMAIL, t: TOK, on: ['P1'] });
check('switching off never asks Stripe for a refund or a proration',
  !JSON.stringify(created).includes('refund') && callsBefore !== JSON.stringify(stripeSubs));

// ---------------------------------------------------------------------------
// The audit's top finding: four public routes reach a paid API with no limit at
// all. The contact form I added made it worse, because one accepted message now
// sends TWO emails.
console.log('\n20. The endpoints that spend money have a ceiling');

const { hit, callerIp, LIMITS } = await import('../lib/ratelimit.js');
const chatApi = (await import('../api/chat.js')).default;

const ipReq = (ip, body) => ({ method: 'POST', body, headers: { host: 'test.local', 'x-forwarded-for': ip } });
const callIp = async (h, ip, body) => { const r = mkres(); await h(ipReq(ip, body), r); return r; };

// ---- the counter itself ----
seed();
let last;
for (let i = 0; i < 5; i++) last = await hit('probe', '1.1.1.1', 3, 60);
check('a bucket counts every hit', last.count === 5, JSON.stringify(last));
check('and reports over the limit once past it', last.ok === false);
check('the first three were allowed', (await hit('probe2', '1.1.1.1', 3, 60)).ok === true);
check('a DIFFERENT caller has its own bucket', (await hit('probe', '2.2.2.2', 3, 60)).ok === true);
check('it says how long to wait', last.retryAfter > 0 && last.retryAfter <= 60, String(last.retryAfter));

// x-forwarded-for is a chain and only the FIRST entry is the real client.
// Trusting the last, or the whole string, lets anyone mint a fresh bucket.
check('the caller is the first address in the chain, not the proxies',
  callerIp({ headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1, 10.0.0.2' } }) === '9.9.9.9');
check('a forged prefix cannot buy a new bucket per request',
  callerIp({ headers: { 'x-forwarded-for': '9.9.9.9, 1.2.3.4' } })
  === callerIp({ headers: { 'x-forwarded-for': '9.9.9.9, 5.6.7.8' } }));
check('a missing header still yields something stable', callerIp({ headers: {} }) === 'unknown');

// ---- the AI endpoint, which fails CLOSED ----
seed();
const msg = { messages: [{ role: 'user', content: 'hello' }] };
let ok = 0, blocked = 0;
for (let i = 0; i < LIMITS.chat.limit + 3; i++) {
  const r = await callIp(chatApi, '3.3.3.3', msg);
  if (r.code === 429) blocked++; else ok++;
}
check('the marketing bot serves a normal number of questions', ok === LIMITS.chat.limit, String(ok));
check('and then refuses, rather than paying Anthropic forever', blocked === 3, String(blocked));

seed();
let r2 = await callIp(chatApi, '4.4.4.4', msg);
check('a different visitor is unaffected by that block', r2.code !== 429, String(r2.code));

// ---- the contact form, which fails OPEN ----
seed();
putSite({ ...freeSite, email: EMAIL, modules: ['P0'] });
const call2 = async (h, ip, body) => { const rr = mkres(); await h(ipReq(ip, body), rr); return rr; };
let sent = 0, stopped = 0;
for (let i = 0; i < LIMITS.siteContact.limit + 2; i++) {
  const r = await call2(siteAction, '5.5.5.5', { action: 'contact', slug: 'free-shop', name: 'Jo', contact: 'jo@x.com', message: 'hi' });
  if (r.code === 429) stopped++; else sent++;
}
check('a real person can send a message, several times over',
  sent === LIMITS.siteContact.limit, String(sent));
check('but a loop is stopped before it becomes an email bill', stopped === 2, String(stopped));
check('and is told to phone instead, rather than just failing',
  (await call2(siteAction, '5.5.5.5', { action: 'contact', slug: 'free-shop', name: 'Jo', contact: 'jo@x.com', message: 'hi' })).body.message.includes('call us'));

// One abused site must not silence every other customer's contact form.
check('another customer site is unaffected', await (async () => {
  putSite({ ...freeSite, slug: 'other-shop', email: 'o@x.com', modules: ['P0'] });
  const r = await call2(siteAction, '5.5.5.5', { action: 'contact', slug: 'other-shop', name: 'Jo', contact: 'jo@x.com', message: 'hi' });
  return r.code === 200;
})());

// ---------------------------------------------------------------------------
// Panel tokens: expiring, and revocable per customer.
//
// Before, a token was HMAC(email) alone: a leaked /panel link was permanent
// access, and the only revocation was rotating KS_PANEL_SECRET, which signs out
// every customer at once.
console.log('\n21. Panel links expire, and can be revoked one customer at a time');

const DAY21 = 86400000;

seed();
check('a freshly minted token verifies', await verifyPanel(EMAIL, TOK));
check('it carries its expiry in the token itself', TOK.indexOf('.') > 0, TOK.slice(0, 12));
check('a token for someone else does not verify', !(await verifyPanel('other@example.com', TOK)));
check('a tampered signature does not verify',
  !(await verifyPanel(EMAIL, TOK.slice(0, -1) + (TOK.endsWith('a') ? 'b' : 'a'))));
check('an empty token does not verify', !(await verifyPanel(EMAIL, '')));

// ---- expiry ----
seed();
const expired = signPanel(EMAIL, NONCE, Date.now() - 1000);
check('an expired token is refused', !(await verifyPanel(EMAIL, expired)));
const nearlyOut = signPanel(EMAIL, NONCE, Date.now() + 5000);
check('one that has not expired yet still works', await verifyPanel(EMAIL, nearlyOut));
check('the expiry cannot be edited without breaking the signature',
  !(await verifyPanel(EMAIL, (Date.now() + 999 * DAY21).toString(36) + TOK.slice(TOK.indexOf('.')))));

// ---- revocation, the whole point ----
seed();
KV.set('ks:accounts', JSON.stringify({
  [EMAIL]: { email: EMAIL, tokenNonce: NONCE, name: 'Test Shop' },
  'other@example.com': { email: 'other@example.com', tokenNonce: 'othernonce123', name: 'Other' },
}));
const otherTok = signPanel('other@example.com', 'othernonce123', Date.now() + 90 * DAY21);
check('two customers, both links working',
  (await verifyPanel(EMAIL, TOK)) && (await verifyPanel('other@example.com', otherTok)));

await revokePanelTokens(EMAIL);
check('revoking one customer kills THEIR link', !(await verifyPanel(EMAIL, TOK)));
check('and leaves everyone else alone', await verifyPanel('other@example.com', otherTok));

const reissued = await panelToken(EMAIL);
check('a new link can be issued after revoking', await verifyPanel(EMAIL, reissued));
check('and the revoked one stays dead', !(await verifyPanel(EMAIL, TOK)));

// ---- legacy grace ----
seed();
const legacy = (await import('node:crypto')).createHmac('sha256', process.env.KS_PANEL_SECRET)
  .update(EMAIL).digest('hex').slice(0, 40);
check('a link sent before this change still works during the grace period',
  await verifyPanel(EMAIL, legacy));
check('a forged legacy token does not', !(await verifyPanel(EMAIL, 'f'.repeat(40))));

// ---- verify NEVER writes, and NEVER throws ----
seed();
const beforeVerify = KV.get('ks:accounts');
await verifyPanel(EMAIL, TOK);
check('verifying does not write to the account, so a leaked link cannot create state',
  KV.get('ks:accounts') === beforeVerify);

// The risk the operator asked about: with the new async KV read, an outage must
// return false, not throw up into the handler.
seed();
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  if (String(u).startsWith('https://kv.test')) throw new Error('ECONNREFUSED');
  return realFetch(u, o);
};
let threw = false, verdict = null;
try { verdict = await verifyPanel(EMAIL, TOK); } catch (e) { threw = true; }
globalThis.fetch = realFetch;
check('when the store is unreachable, verify returns false rather than throwing',
  threw === false && verdict === false, threw ? 'it threw' : String(verdict));

// ---- the lazy nonce race the operator asked about ----
// upsertAccount is a read-modify-write of the whole account map, so a
// simultaneous write from another flow can drop a field. If it drops the nonce
// we just wrote, the token we mint must still be the one that verifies.
seed();
KV.set('ks:accounts', JSON.stringify({ [EMAIL]: { email: EMAIL, name: 'Legacy, no nonce' } }));
const [mintedA, mintedB] = await Promise.all([panelToken(EMAIL), panelToken(EMAIL)]);
check('two flows minting at once both produce a working link',
  (await verifyPanel(EMAIL, mintedA)) && (await verifyPanel(EMAIL, mintedB)),
  JSON.stringify({ a: mintedA.slice(0, 10), b: mintedB.slice(0, 10) }));
check('and the account ends up with exactly one nonce',
  typeof JSON.parse(KV.get('ks:accounts'))[EMAIL].tokenNonce === 'string');

// A legacy account gets a nonce the first time a link is minted for it.
seed();
KV.set('ks:accounts', JSON.stringify({ [EMAIL]: { email: EMAIL, name: 'Legacy' } }));
check('a pre-nonce account has none to start', !JSON.parse(KV.get('ks:accounts'))[EMAIL].tokenNonce);
const upgraded = await panelToken(EMAIL);
check('minting gives it one', !!JSON.parse(KV.get('ks:accounts'))[EMAIL].tokenNonce);
check('and the link works', await verifyPanel(EMAIL, upgraded));
check('a mint for an account that does not exist yields no token',
  (await panelToken('nobody@example.com')) === '');

// ---- the endpoints still work end to end with the new token ----
seed();
r = await call(switchApi, { action: 'state', e: EMAIL, t: TOK });
check('the panel still loads with a new-format token', r.code === 200, JSON.stringify(r.body).slice(0, 60));
r = await call(switchApi, { action: 'state', e: EMAIL, t: 'not-a-token' });
check('and refuses a junk one', r.code === 401);

// ---------------------------------------------------------------------------
// HANDING A BUSINESS THEIR WEBSITE, IN ONE ACTION.
//
// Not one customer site had ever been published: the demo pages are static
// files /s/<slug> knows nothing about, `html` was not a savable field, and
// publishing, claiming and onboarding were separate steps on different screens.
// Four correct actions in the wrong order leaves a customer with a panel
// controlling a 404, so these check the chain and, more importantly, the two
// ways it is allowed to refuse.
console.log('\nHanding a business their website');

// THE REFUSAL THAT MATTERS. Publishing a record with nothing in it puts a blank
// page up under a real business's name, and marks it indexable while doing so.
putSite({ slug: 'empty-shop', business: 'Empty Shop', published: false, claimed: false, modules: ['P0'] });
r = await asAdmin({ action: 'site-golive', slug: 'empty-shop' });
check('it refuses to publish a record with no page in it', r.code === 400 && r.body.error === 'no_html_to_publish', JSON.stringify(r.body));
check('and the record is still a draft afterwards',
  JSON.parse(KV.get('ks:site:empty-shop')).published === false);

r = await asAdmin({ action: 'site-golive', slug: '' });
check('a missing slug is refused', r.code === 400, JSON.stringify(r.body));

const PAGE = '<html><head><title>Cut</title></head><body><h1>Fades</h1></body></html>';

// Publish WITHOUT handing it over. These are two different decisions.
putSite({ slug: 'draft-cuts', business: 'Draft Cuts', published: false, claimed: false, modules: ['P0'] });
r = await asAdmin({ action: 'site-golive', slug: 'draft-cuts', html: PAGE });
check('a page can be published without onboarding anyone', r.code === 200 && r.body.ok, JSON.stringify(r.body).slice(0, 120));
check('and nobody was set up as a customer', !r.body.steps.customer, JSON.stringify(r.body.steps));
let rec = JSON.parse(KV.get('ks:site:draft-cuts'));
check('the page is stored on the record', rec.html === PAGE, String(rec.html).slice(0, 40));
check('it is published', rec.published === true);
check('and claimed, which is what lets it be indexed', rec.claimed === true);

// The whole chain.
putSite({ slug: 'fade-house', business: 'Fade House', published: false, claimed: false, modules: ['P0'] });
r = await asAdmin({ action: 'site-golive', slug: 'fade-house', html: PAGE, email: 'owner@fadehouse.com', name: 'Ray' });
check('the whole chain runs in one call', r.code === 200 && r.body.ok, JSON.stringify(r.body).slice(0, 140));
check('the owner gets an account', r.body.steps.customer && r.body.steps.customer.ok, JSON.stringify(r.body.steps.customer));
check('with a panel link that carries a token',
  /\/panel\?e=.*&t=./.test((r.body.steps.customer || {}).portalUrl || ''), (r.body.steps.customer || {}).portalUrl);
check('and the account is JOINED to the website, so their switches do something',
  (r.body.steps.customer.link || {}).linked === true, JSON.stringify(r.body.steps.customer.link));
rec = JSON.parse(KV.get('ks:site:fade-house'));
check('the record carries their email, which is what the join reads',
  rec.email === 'owner@fadehouse.com', rec.email);
check('the site is live', rec.published === true && rec.claimed === true);

// RESEND_API_KEY is deleted at the top of this file, so the mail cannot send.
// That must be reported, not swallowed: a portal link that never arrives looks
// exactly like nothing having happened.
check('it says out loud that the email did not send',
  r.body.steps.customer.emailed === false, JSON.stringify(r.body.steps.customer.emailed));
check('and preflight names what is missing rather than failing quietly',
  r.body.config && r.body.config.ok === false && r.body.config.missing.includes('RESEND_API_KEY'),
  JSON.stringify(r.body.config));
check('preflight explains what each missing setting costs you',
  typeof r.body.config.why.RESEND_API_KEY === 'string' && r.body.config.why.RESEND_API_KEY.length > 10);
check('preflight never returns a secret VALUE, only whether it is set',
  !JSON.stringify(r.body.config).includes('testadminkey') && !JSON.stringify(r.body.config).includes('panelsecret'));

r = await asAdmin({ action: 'preflight' });
check('preflight also stands alone, so settings can be checked any time',
  r.code === 200 && Array.isArray(r.body.config.missing), JSON.stringify(r.body).slice(0, 120));
check('and it knows the settings that ARE present', !r.body.config.missing.includes('STRIPE_SECRET_KEY'),
  JSON.stringify(r.body.config.missing));

// A re-publish must not wipe the page when only the owner is being changed.
r = await asAdmin({ action: 'site-golive', slug: 'fade-house', email: 'newowner@fadehouse.com' });
check('re-running it without a page keeps the page it already had',
  r.code === 200 && JSON.parse(KV.get('ks:site:fade-house')).html === PAGE);

r = await call(master, { action: 'site-golive', slug: 'fade-house', html: PAGE, token: 'nope' });
check('and none of this is reachable without the operator key', r.code === 401, JSON.stringify(r.body));

// ---------------------------------------------------------------------------
// RESENDING A PORTAL LINK, AND PROVING IT WILL ACTUALLY WORK.
//
// "Resend" on its own is the useless half: a link that opens a panel whose
// switches drive nothing is worse than no link, because the customer now
// believes they have control. So the action reads the join, repairs it when it
// can, and reads it AGAIN. These check that it reports what it found rather
// than what it attempted, and that attached and working stay separate, because
// a published:false record is a hard 404 and an attached panel over it is still
// a panel driving nothing.
console.log('\nResending a portal link');

// Accounts live in one blob, the way lib/store.js writes them.
function putAccount(rec) {
  const all = JSON.parse(KV.get('ks:accounts') || '{}');
  all[rec.email] = rec;
  KV.set('ks:accounts', JSON.stringify(all));
}

r = await asAdmin({ action: 'resend-portal', email: 'nobody@nowhere.com' });
check('an account that does not exist is refused', r.code === 404 && r.body.error === 'no_such_account', JSON.stringify(r.body));
r = await asAdmin({ action: 'resend-portal', email: 'not-an-email' });
check('and so is junk in the email box', r.code === 400, JSON.stringify(r.body));

// Attached to a site that is LIVE: the only state where their switches work.
putSite({ slug: 'live-cuts', business: 'Live Cuts', email: 'live@cuts.com', published: true, claimed: true, modules: ['P0', 'P9'] });
putAccount({ email: 'live@cuts.com', name: 'Lee', site: 'Live Cuts', plan: ['P0'], tokenNonce: NONCE });
r = await asAdmin({ action: 'resend-portal', email: 'live@cuts.com' });
check('a live customer comes back working', r.code === 200 && r.body.working === true, JSON.stringify(r.body).slice(0, 160));
check('and attached, which is the separate half', r.body.attached === true);
check('it names the site so the claim can be checked by eye', r.body.site.slug === 'live-cuts', JSON.stringify(r.body.site));
check('and hands back a real panel link', /\/panel\?e=.*&t=./.test(r.body.portalUrl || ''), r.body.portalUrl);
check('nothing was repaired, because nothing was broken', r.body.repaired === false);

// ATTACHED BUT NOT PUBLISHED. The trap: the join is fine, so a naive check says
// yes, but api/site.js 404s a published:false record and the panel drives air.
putSite({ slug: 'draft-cuts2', business: 'Draft Cuts 2', email: 'draft@cuts.com', published: false, claimed: false, modules: ['P0'] });
putAccount({ email: 'draft@cuts.com', name: 'Dee', site: 'Draft Cuts 2', plan: ['P0'], tokenNonce: NONCE });
r = await asAdmin({ action: 'resend-portal', email: 'draft@cuts.com' });
check('an unpublished site reports ATTACHED', r.body.attached === true, JSON.stringify(r.body).slice(0, 140));
check('but NOT working, because a draft is a 404 and the switches do nothing',
  r.body.working === false, JSON.stringify({ attached: r.body.attached, working: r.body.working }));

// NOT ATTACHED, AND REPAIRABLE. The account names a business whose record
// exists, so the action should make the join and then confirm it by re-reading.
putSite({ slug: 'orphan-barbers', business: 'Orphan Barbers', published: true, claimed: true, modules: ['P0'] });
putAccount({ email: 'orphan@barbers.com', name: 'Ori', site: 'Orphan Barbers', plan: ['P0'], tokenNonce: NONCE });
r = await asAdmin({ action: 'resend-portal', email: 'orphan@barbers.com' });
check('a missing join is repaired rather than merely reported', r.body.repaired === true, JSON.stringify(r.body).slice(0, 160));
check('and the repair is confirmed by reading it back, not assumed', r.body.attached === true && r.body.working === true);
check('the site record now carries their email, which is what the join reads',
  JSON.parse(KV.get('ks:site:orphan-barbers')).email === 'orphan@barbers.com');

// NOT ATTACHED AND NOT REPAIRABLE. It must say so plainly rather than sending a
// link and calling it done.
putAccount({ email: 'ghost@nowhere.com', name: 'Gus', site: 'No Such Business Anywhere', plan: ['P0'], tokenNonce: NONCE });
r = await asAdmin({ action: 'resend-portal', email: 'ghost@nowhere.com' });
check('an unattachable account is reported, not papered over',
  r.body.attached === false && r.body.working === false, JSON.stringify(r.body).slice(0, 160));
check('and it says WHY', typeof r.body.reason === 'string' && r.body.reason.length > 0, r.body.reason);
check('the email still goes, because a panel link is useful even before the site is',
  Object.prototype.hasOwnProperty.call(r.body, 'sent'), JSON.stringify(r.body.sent));

// It must never steal a site that belongs to somebody else.
putSite({ slug: 'taken-shop', business: 'Taken Shop', email: 'first@taken.com', published: true, claimed: true, modules: ['P0'] });
putAccount({ email: 'second@taken.com', name: 'Sam', site: 'Taken Shop', plan: ['P0'], tokenNonce: NONCE });
r = await asAdmin({ action: 'resend-portal', email: 'second@taken.com' });
check('it will not attach a website that belongs to another customer',
  r.body.attached === false && r.body.reason === 'owned_by_other', JSON.stringify(r.body).slice(0, 160));
check('and the real owner still owns it', JSON.parse(KV.get('ks:site:taken-shop')).email === 'first@taken.com');

r = await call(master, { action: 'resend-portal', email: 'live@cuts.com', token: 'nope' });
check('and none of it is reachable without the operator key', r.code === 401);

// The LIST has to carry the same truth, or the screen shows a portal link for
// every account and says nothing about whether that panel drives anything.
r = await asAdmin({ action: 'list' });
const byEmail = Object.fromEntries((r.body.accounts || []).map((a) => [a.email, a]));
check('the list marks a live customer as working', byEmail['live@cuts.com'] && byEmail['live@cuts.com'].working === true,
  JSON.stringify(byEmail['live@cuts.com'] || null).slice(0, 140));
check('the list marks an unpublished one as attached but not working',
  byEmail['draft@cuts.com'] && byEmail['draft@cuts.com'].attached === true && byEmail['draft@cuts.com'].working === false,
  JSON.stringify(byEmail['draft@cuts.com'] || null).slice(0, 140));
check('and marks an unattached one as neither',
  byEmail['ghost@nowhere.com'] && byEmail['ghost@nowhere.com'].attached === false,
  JSON.stringify(byEmail['ghost@nowhere.com'] || null).slice(0, 140));
check('the list names the slug so the claim can be checked by eye',
  byEmail['live@cuts.com'].siteSlug === 'live-cuts', byEmail['live@cuts.com'].siteSlug);

// ---------------------------------------------------------------------------
// THE CUSTOMER'S OWN WEBSITE, LINKED FROM THEIR PANEL.
//
// The header line was `account.site`, a string typed at signup, which can be a
// domain that does not resolve, a business name, or nothing. The panel could
// therefore tell someone their website was somewhere it was not. This is the
// record we actually serve, and it only appears once it is really published,
// because api/site.js treats a draft as a hard 404 and a dead link in their own
// panel is worse than no link.
console.log('\nThe website link in their panel');

seed();  // test-shop is published and claimed and joined to EMAIL
r = await call(switchApi, { action: 'state', e: EMAIL, t: TOK });
check('a published site gives them a link', r.body.siteUrl === '/s/test-shop', JSON.stringify(r.body.siteUrl));
check('and names the slug', r.body.siteSlug === 'test-shop', r.body.siteSlug);
check('and says it is published', r.body.sitePublished === true);
check('the typed-at-signup string is still returned separately, not conflated',
  Object.prototype.hasOwnProperty.call(r.body, 'site'), JSON.stringify(r.body.site));

// A DRAFT MUST NOT BE LINKED. This is the case that would send a paying
// customer to a 404 on their own website.
putSite({ slug: 'test-shop', business: 'Test Shop', email: EMAIL, modules: ['P0'], published: false, claimed: false });
r = await call(switchApi, { action: 'state', e: EMAIL, t: TOK });
check('an unpublished site gives NO link, rather than one that 404s',
  r.body.siteUrl === '', JSON.stringify(r.body.siteUrl));
check('but the panel still knows it exists, so we can tell them why',
  r.body.siteSlug === 'test-shop' && r.body.sitePublished === false, JSON.stringify({ slug: r.body.siteSlug, pub: r.body.sitePublished }));

// No record joined at all: the state every account was in before today.
KV.set('ks:siteemail', {});
r = await call(switchApi, { action: 'state', e: EMAIL, t: TOK });
check('an account with no website gets no link and no slug',
  r.body.siteUrl === '' && r.body.siteSlug === '', JSON.stringify({ url: r.body.siteUrl, slug: r.body.siteSlug }));
check('and the panel still loads rather than breaking', r.code === 200);

seed();

// ---------------------------------------------------------------------------
// TAKING A SITE DOWN AT THE OWNER'S REQUEST.
//
// He never answered, we published, then he answered and asked for it off. Two
// different asks and two different actions, because guessing between them is
// how you either leave a page up that someone asked you to remove, or destroy
// work that was only meant to be paused.
console.log('\nTaking a site down');

putSite({ slug: 'takedown-shop', business: 'Takedown Shop', email: 'owner@takedown.com',
  html: '<html><body>their page</body></html>', published: true, claimed: true, modules: ['P0'] });

r = await asAdmin({ action: 'site-unpublish', slug: 'takedown-shop' });
check('unpublish takes it offline', r.code === 200 && r.body.published === false, JSON.stringify(r.body).slice(0, 140));
check('and drops claimed, so it cannot be indexed if it goes back up by accident',
  r.body.claimed === false, JSON.stringify(r.body.claimed));
check('but KEEPS the page, because this is a pause not a deletion', r.body.keptPage === true);
const kept = JSON.parse(KV.get('ks:site:takedown-shop'));
check('the html really is still there', kept.html === '<html><body>their page</body></html>');

// Deleting is not undoable, so one mistyped field must not do it.
r = await asAdmin({ action: 'site-delete', slug: 'takedown-shop' });
check('delete refuses without a matching confirmation', r.code === 400 && r.body.error === 'confirm_must_match_slug', JSON.stringify(r.body));
r = await asAdmin({ action: 'site-delete', slug: 'takedown-shop', confirm: 'something-else' });
check('and refuses a confirmation that does not match', r.code === 400, JSON.stringify(r.body));
check('the site is still there after both refusals', !!KV.get('ks:site:takedown-shop'));

r = await asAdmin({ action: 'site-delete', slug: 'takedown-shop', confirm: 'takedown-shop' });
check('a matching confirmation deletes it', r.code === 200 && r.body.deleted === true, JSON.stringify(r.body).slice(0, 140));
check('the record is gone', !KV.get('ks:site:takedown-shop'));
check('the LIST entry is gone, so it stops showing in /master',
  !(KV.get('ks:siteidx') || {})['takedown-shop'], JSON.stringify(Object.keys(KV.get('ks:siteidx') || {})));
check('and the customer join is gone, so their panel stops syncing to a dead site',
  !(KV.get('ks:siteemail') || {})['owner@takedown.com'], JSON.stringify(KV.get('ks:siteemail') || {}));
check('it reports what it removed, so a takedown can be evidenced',
  r.body.business === 'Takedown Shop' && r.body.wasPublished === false, JSON.stringify(r.body));

r = await asAdmin({ action: 'site-delete', slug: 'takedown-shop', confirm: 'takedown-shop' });
check('deleting it twice says not found rather than pretending', r.code === 404, JSON.stringify(r.body));
r = await asAdmin({ action: 'site-unpublish', slug: 'never-existed' });
check('unpublishing something that does not exist says so', r.code === 404, JSON.stringify(r.body));
r = await call(master, { action: 'site-delete', slug: 'x', confirm: 'x', token: 'nope' });
check('and neither is reachable without the operator key', r.code === 401);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
