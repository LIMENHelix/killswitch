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
    const [cmd, key, f, v] = args;
    if (cmd === 'GET') return json({ result: KV.has(key) ? KV.get(key) : null });
    if (cmd === 'SET') { KV.set(key, v === undefined ? f : v); return json({ result: 'OK' }); }
    if (cmd === 'HSET') { const h = KV.get(key) || {}; h[f] = v; KV.set(key, h); return json({ result: 1 }); }
    if (cmd === 'HGET') { const h = KV.get(key) || {}; return json({ result: h[f] == null ? null : h[f] }); }
    if (cmd === 'HGETALL') {
      const h = KV.get(key) || {};
      const flat = []; for (const [k, val] of Object.entries(h)) flat.push(k, val);
      return json({ result: flat });
    }
    throw new Error('unexpected kv cmd ' + cmd);
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
    if (path.startsWith('/subscription_items')) return json({ id: 'si_new' });
    if (path.startsWith('/subscriptions/')) return json({ id: 'sub_1', current_period_end: 9999999999 });
    throw new Error('unexpected stripe path ' + path);
  }

  if (u.startsWith('https://api.anthropic.com')) {
    return json({ content: [{ type: 'text', text: 'Got it, I will pass that to your builder.' }] });
  }
  throw new Error('unexpected fetch ' + u);
};

const { panelToken } = await import('file:///C:/Users/Chris/killswitch/lib/panel-auth.js');
const support = (await import('file:///C:/Users/Chris/killswitch/api/support.js')).default;
const switchApi = (await import('file:///C:/Users/Chris/killswitch/api/switch.js')).default;

function mkres() {
  const r = { code: 0, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (o) => { r.body = o; return r; };
  return r;
}
const call = async (h, body) => { const res = mkres(); await h({ method: 'POST', body, headers: { host: 'test.local' } }, res); return res; };

const EMAIL = 'shop@example.com';
const TOK = panelToken(EMAIL);
const P3 = 'price_1ToXlsPmxnF3rtBM9Dc9mDul';  // Online Booking
const P11 = 'price_1TnMiMPmxnF3rtBMgqTJpLh6'; // Care Plan

function seed() {
  KV.clear(); stripeSubs = []; stripeCustomers = []; created = [];
  KV.set('ks:accounts', JSON.stringify({ [EMAIL]: { email: EMAIL, name: 'Test Shop', plan: ['P0'] } }));
  KV.set('ks:sites', JSON.stringify({
    'test-shop': { slug: 'test-shop', business: 'Test Shop', email: EMAIL, phone: '816-555-0101', modules: ['P0'], published: true },
  }));
}
const site = () => JSON.parse(KV.get('ks:sites'))['test-shop'];
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
const master = (await import('file:///C:/Users/Chris/killswitch/api/master.js')).default;
const asAdmin = (body) => call(master, { token: 'testadminkey', ...body });

KV.clear();
KV.set('ks:sites', JSON.stringify({ 'test-shop': {
  slug: 'test-shop', business: 'Test Shop', email: EMAIL, trade: 'auto repair',
  phone: '816-555-0101', street: '123 Main St', city: 'Lenexa', state: 'KS', zip: '66215',
  about: 'Family run since 1998.', tagline: 'Brakes done right',
  hours: [{ d: 'Mon to Fri', h: '8am to 6pm' }],
  services: [{ name: 'Brakes', desc: 'Pads and rotors' }],
  modules: ['P0', 'P3'], published: true,
} }));

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
const admin = (await import('file:///C:/Users/Chris/killswitch/api/admin.js')).default;
const signup = (await import('file:///C:/Users/Chris/killswitch/api/signup.js')).default;

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
check('two people on different leads both survive', l1.stage === 'responded' && l2.notes === 'left a voicemail',
  JSON.stringify({ l1: l1.stage, l2: l2.notes }));
check('lead identity is intact after all that', l1.name === 'Auto Tech Services Center' && l2.phone === '913-722-5151');

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
