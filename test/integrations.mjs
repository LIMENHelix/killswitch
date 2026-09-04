// The customer connection center over a fake Redis. No provider account,
// credential, Stripe call, or real network request is used by this test.
import path from 'node:path';

process.env.KV_REST_API_URL = 'https://kv.integrations.test/';
process.env.KV_REST_API_TOKEN = 'kvtok';
process.env.KS_PANEL_SECRET = 'panelsecret';

const KV = new Map();
globalThis.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith('https://kv.integrations.test')) throw new Error('unexpected network call: ' + url);
  const input = JSON.parse(opts.body);
  const run = (a) => {
    const [op, key, field, value] = a;
    if (op === 'GET') return KV.has(key) ? KV.get(key) : null;
    if (op === 'SET' && String(a[3]).toUpperCase() === 'NX') { if (KV.has(key)) return null; KV.set(key, field); return 'OK'; }
    if (op === 'SET') { KV.set(key, value === undefined ? field : value); return 'OK'; }
    if (op === 'HGET') return (KV.get(key) || {})[field] ?? null;
    if (op === 'HGETALL') { const out = []; for (const [k, v] of Object.entries(KV.get(key) || {})) out.push(k, v); return out; }
    if (op === 'HSET') { const h = KV.get(key) || {}; h[field] = value; KV.set(key, h); return 1; }
    if (op === 'HDEL') { const h = KV.get(key) || {}; delete h[field]; KV.set(key, h); return 1; }
    if (op === 'INCR') { const n = Number(KV.get(key) || 0) + 1; KV.set(key, String(n)); return n; }
    if (op === 'EXPIRE') return 1;
    throw new Error('unsupported ' + op);
  };
  const result = String(url).endsWith('/pipeline')
    ? input.map((a) => ({ result: run(a) }))
    : { result: run(input) };
  return { ok: true, status: 200, json: async () => result };
};

const integrations = (await import('../api/integrations.js')).default;
const { upsertAccount } = await import('../lib/store.js');
const { upsertSite, getSite, SITE_DEFAULT } = await import('../lib/sites.js');
const { panelToken } = await import('../lib/panel-auth.js');
const { getLifecycleState, getLifecycleEvents } = await import('../lib/lifecycle.js');
const { validateIntegration } = await import('../lib/integrations.js');
const { renderSite } = await import('../lib/site-template.js');
const { applyModules } = await import('../lib/site-modules.js');

let passed = 0, failed = 0;
function check(name, condition, detail = '') {
  if (condition) { console.log('  PASS  ' + name); passed++; }
  else { console.log('  FAIL  ' + name + (detail ? ' <- ' + detail : '')); failed++; }
}
function mkRes() {
  const r = { code: 0, body: null };
  r.status = (code) => { r.code = code; return r; };
  r.json = (body) => { r.body = body; return r; };
  return r;
}
function req(body, method = 'POST') {
  return { method, body, query: {}, headers: { 'x-forwarded-for': '198.51.100.11' } };
}
async function call(body, method) { const res = mkRes(); await integrations(req(body, method), res); return res; }

const MINE = 'owner@example.com';
const THEIRS = 'other@example.com';
await upsertAccount({ email: MINE, name: 'Owner Shop', plan: ['P0', 'P1', 'P3', 'P7'] });
await upsertAccount({ email: THEIRS, name: 'Other Shop', plan: ['P0'] });
await upsertSite({ business: 'Owner Shop', email: MINE, published: true, claimed: true, modules: ['P0', 'P1', 'P3', 'P7'] });
await upsertSite({ business: 'Other Shop', email: THEIRS, published: true, claimed: true, modules: ['P0'] });
const token = await panelToken(MINE);

console.log('\nONLY THE CUSTOMER PANEL CAN CHANGE ITS OWN CONNECTIONS');
check('GET is refused', (await call({}, 'GET')).code === 405);
check('a missing token is refused', (await call({ e: MINE, action: 'list' })).code === 401);
check('another customer cannot reuse the token', (await call({ e: THEIRS, t: token, action: 'list' })).code === 401);
const listed = await call({ e: MINE, t: token, action: 'list' });
check('all three paid connection types are listed', listed.code === 200 && listed.body.integrations.length === 3, JSON.stringify(listed.body));
check('all start visibly disconnected', listed.body.integrations.every((x) => x.active && !x.connected));

console.log('\nPUBLIC LINKS CONNECT THE LIVE SITE WITHOUT PROVIDER CREDENTIALS');
const google = await call({ e: MINE, t: token, action: 'set', field: 'googleBusinessProfile', value: 'https://maps.app.goo.gl/OwnerShop#place' });
const booking = await call({ e: MINE, t: token, action: 'set', field: 'bookingUrl', value: 'https://calendar.owner.example/book' });
const payment = await call({ e: MINE, t: token, action: 'set', field: 'payUrl', value: 'https://buy.stripe.com/test_123' });
check('Google profile connects', google.code === 200 && google.body.connected && !google.body.value.includes('#'), JSON.stringify(google.body));
check('booking calendar connects', booking.code === 200 && booking.body.provider === 'calendar.owner.example');
check('recognized hosted checkout connects', payment.code === 200 && payment.body.provider === 'buy.stripe.com');
const saved = await getSite('owner-shop');
check('all destinations are on this customer site', saved.googleBusinessProfile && saved.bookingUrl && saved.payUrl, JSON.stringify(saved));
check('naming another slug in the request cannot change it', !(await getSite('other-shop')).bookingUrl);

const page = renderSite(saved, {});
check('Google profile becomes LocalBusiness sameAs data', page.includes('"sameAs":["https://maps.app.goo.gl/OwnerShop"]'));
check('booking opens the provider page instead of a CSP-blocked iframe', page.includes('Choose a time') && !page.includes('<iframe'));
check('payment is a hosted provider link', page.includes('https://buy.stripe.com/test_123'));
const bespoke = applyModules('<html><head></head><body>Custom</body></html>', { ...saved, siteUrl: 'https://example.test/s/owner-shop' });
check('a bespoke page gets the Google sameAs data too', bespoke.includes('"sameAs":["https://maps.app.goo.gl/OwnerShop"]'));

console.log('\nUNSAFE OR MISLABELLED DESTINATIONS ARE REFUSED');
check('plain HTTP is refused', validateIntegration('bookingUrl', 'http://calendar.example/book').error === 'valid_https_link_required');
check('embedded credentials are refused', validateIntegration('bookingUrl', 'https://user:pass@calendar.example/book').error === 'valid_https_link_required');
check('private-network destinations are refused', validateIntegration('bookingUrl', 'https://192.168.1.8/book').error === 'valid_https_link_required');
check('a non-Google page cannot pose as a Business Profile', (await call({ e: MINE, t: token, action: 'set', field: 'googleBusinessProfile', value: 'https://example.com/profile' })).body.error === 'google_profile_link_required');
check('an arbitrary page cannot pose as a hosted checkout', (await call({ e: MINE, t: token, action: 'set', field: 'payUrl', value: 'https://example.com/pay' })).body.error === 'recognized_payment_provider_required');
check('an unknown connection field is refused', (await call({ e: MINE, t: token, action: 'set', field: '__proto__', value: 'https://example.com' })).code === 400);

const freeToken = await panelToken(THEIRS);
const noEntitlement = await call({ e: THEIRS, t: freeToken, action: 'set', field: 'bookingUrl', value: 'https://calendar.example/book' });
check('a customer cannot configure a module they do not have', noEntitlement.code === 403 && noEntitlement.body.phase === 'P3');

console.log('\nTHE LIFECYCLE MOVES WITH THE REAL CONNECTION STATE');
let life = await getLifecycleState(MINE);
check('all required connections activate the customer', life.stage === 'active' && life.status === 'active', JSON.stringify(life));
check('the integrations-ready transition is kept in history', (await getLifecycleEvents(MINE)).some((e) => e.stage === 'integrations_ready'));
const disconnected = await call({ e: MINE, t: token, action: 'set', field: 'bookingUrl', value: '' });
life = await getLifecycleState(MINE);
check('disconnecting is explicit success', disconnected.code === 200 && disconnected.body.connected === false);
check('disconnecting a required calendar makes the blocker visible', life.status === 'blocked' && life.blocker === 'calendar_booking_url', JSON.stringify(life));

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
