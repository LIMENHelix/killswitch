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
      if (cmd === 'SET') { KV.set(key, v === undefined ? f : v); return 'OK'; }
      if (cmd === 'HSET') { const h = KV.get(key) || {}; h[f] = v; KV.set(key, h); return 1; }
      if (cmd === 'HGET') { const h = KV.get(key) || {}; return h[f] == null ? null : h[f]; }
      if (cmd === 'HDEL') { const h = KV.get(key) || {}; delete h[f]; KV.set(key, h); return 1; }
      if (cmd === 'HGETALL') {
        const h = KV.get(key) || {};
        const flat = []; for (const [k, val] of Object.entries(h)) flat.push(k, val);
        return flat;
      }
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
  KV.set('ks:accounts', JSON.stringify({ [EMAIL]: { email: EMAIL, name: 'Test Shop', plan: ['P0'] } }));
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
const master = (await import('file:///C:/Users/Chris/killswitch/api/master.js')).default;
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
const siteApi = (await import('file:///C:/Users/Chris/killswitch/api/site.js')).default;
const { renderSite } = await import('file:///C:/Users/Chris/killswitch/lib/site-template.js');
const { getSite, upsertSite: upsertSiteFn } = await import('file:///C:/Users/Chris/killswitch/lib/sites.js');

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
const { lobSend } = await import('file:///C:/Users/Chris/killswitch/lib/mailer.js');
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
const agent = (await import('file:///C:/Users/Chris/killswitch/api/agent.js')).default;
const ag = (b) => call(agent, { token: 'agent_test_tok', ...b });

KV.clear(); stripeSubs = []; stripeCustomers = [];
KV.set('ks:leads', JSON.stringify([
  { id: 'A', name: "Charlie's Brake & Muffler", trade: 'auto repair', phone: '(913) 859-9994', city: 'Lenexa', state: 'KS' },
  { id: 'B', name: 'Paying Shop', trade: 'bakery', phone: '816-111-2222', city: 'KC', state: 'MO' },
]));
KV.set('ks:leadmeta', { A: JSON.stringify({ siteSlug: 'charlies-brake-muffler' }), B: JSON.stringify({ siteSlug: 'paying-shop' }) });
putSite({ slug: 'charlies-brake-muffler', business: "Charlie's Brake & Muffler", city: 'Lenexa', trade: 'auto repair', leadId: 'A', published: false, claimed: false, modules: ['P0'] });
putSite({ slug: 'paying-shop', business: 'Paying Shop', city: 'KC', email: EMAIL, leadId: 'B', published: true, claimed: true, modules: ['P0'] });
KV.set('ks:accounts', JSON.stringify({ [EMAIL]: { email: EMAIL, name: 'Pat', stripeCustomerId: 'cus_paid' } }));
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
const { classify, hookLine, segment: segmentFn } = await import('file:///C:/Users/Chris/killswitch/lib/web-presence.js');
const { draftFromLead } = await import('file:///C:/Users/Chris/killswitch/lib/draft-site.js');

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
// A module with nothing built behind it must not be sellable, and retiring one
// must not quietly cancel it for whoever already bought it. Both halves matter:
// the first is the liability, the second is the way a naive fix creates a new one.
console.log('\n11. Retired modules: cannot be bought, are not confiscated');

const checkout = (await import('file:///C:/Users/Chris/killswitch/api/checkout.js')).default;
const P5 = 'price_1ToXluPmxnF3rtBMEleF5u3D';  // CRM, retired
const P6 = 'price_1ToXlvPmxnF3rtBM7aDkUq1Y';  // Marketing Automation, retired

seed();
r = await call(checkout, { phases: ['P5', 'P6'] });
check('the public checkout refuses a retired module',
  r.code === 400 && r.body.error === 'not_for_sale', 'got ' + r.code + ' ' + JSON.stringify(r.body));
check('and no Stripe session was created for it', created.length === 0, created.length + ' created');

// The dangerous near-miss: silently dropping the unbuilt item and charging for
// the rest would take money for a basket the customer never agreed to.
seed();
r = await call(checkout, { phases: ['P1', 'P5'] });
check('a basket containing a retired module is refused whole, not trimmed',
  r.code === 400 && r.body.error === 'not_for_sale' && created.length === 0,
  'got ' + r.code + ', ' + created.length + ' sessions');

seed();
r = await call(checkout, { phases: ['P1', 'P3'], email: 'buyer@example.com' });
check('a basket of real modules still checks out', r.code === 200 && !!r.body.url, 'got ' + r.code);

// The panel is the other door into Stripe and had the same hole.
seed();
r = await call(switchApi, { action: 'apply', e: EMAIL, t: TOK, on: ['P5'] });
check('the panel cannot start a retired module either', created.length === 0, created.length + ' created');
check('and it never reaches their live site', !site().modules.includes('P5'), JSON.stringify(site().modules));

// Grandfathering. Deleting P5 from the panel catalogue outright would mean the
// browser stopped sending it, and the server would read that as "turn it off":
// a paying customer silently loses what they bought. They keep it.
function seedPaidP5() {
  seed();
  KV.set('ks:accounts', JSON.stringify({ [EMAIL]: { email: EMAIL, name: 'Test Shop', plan: ['P0'], stripeCustomerId: 'cus_old' } }));
  putSite({ slug: 'test-shop', business: 'Test Shop', email: EMAIL, phone: '816-555-0101', modules: ['P0', 'P5'], published: true, claimed: true });
  stripeSubs = [{
    id: 'sub_1', status: 'active', cancel_at_period_end: false, current_period_end: 9999999999,
    items: { data: [{ id: 'si_p5', price: { id: P5 }, current_period_end: 9999999999 }] },
  }];
}

seedPaidP5();
r = await call(switchApi, { action: 'state', e: EMAIL, t: TOK });
check('someone who already bought it still sees it in their panel',
  r.body.modules && r.body.modules.P5 && r.body.modules.P5.state === 'active', JSON.stringify(r.body.modules));

seedPaidP5();
r = await call(switchApi, { action: 'apply', e: EMAIL, t: TOK, on: ['P5'] });
check('saving the panel does not confiscate what they already pay for',
  r.body.modules && r.body.modules.P5 && r.body.modules.P5.state === 'active', JSON.stringify(r.body));
check('and it stays on their site', site().modules.includes('P5'), JSON.stringify(site().modules));

seedPaidP5();
r = await call(switchApi, { action: 'apply', e: EMAIL, t: TOK, on: [] });
check('but they can still switch it off themselves',
  r.body.modules && r.body.modules.P5 && r.body.modules.P5.state === 'ending', JSON.stringify(r.body));

// The bot was quoting a price for both of them.
const chatSrc = await (await import('node:fs/promises')).readFile('C:/Users/Chris/killswitch/api/chat.js', 'utf8');
check('the sales bot no longer lists a CRM or automation price',
  !/P5 CRM/.test(chatSrc) && !/P6 Marketing Automation/.test(chatSrc));
check('and it is told to refuse them by name', /NO CRM product/.test(chatSrc));

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
KV.set('ks:accounts', JSON.stringify({ [EMAIL]: { email: EMAIL, name: 'Test Shop', plan: ['P0', 'P3'], stripeCustomerId: 'cus_old' } }));
r = await call(checkout, { phases: ['P1'], email: EMAIL });
check('an existing customer keeps their record', accounts()[EMAIL].name === 'Test Shop'
  && accounts()[EMAIL].plan.includes('P3'), JSON.stringify(accounts()[EMAIL]));
check('and reuses their Stripe customer instead of making a second one',
  decodeURIComponent(created[0] || '').includes('customer=cus_old'), decodeURIComponent(created[0] || '').slice(0, 200));

// The retirement gate has to hold on this path too, before any account is made.
seed();
r = await call(checkout, { phases: ['P5'], email: NEW });
check('a retired module is still refused even with a valid email',
  r.code === 400 && r.body.error === 'not_for_sale' && created.length === 0);

// ---------------------------------------------------------------------------
// "Contact form" has always been listed under the free tier and the template had
// none: the only two forms were booking (P3) and the AI widget (P9), both paid.
// A free customer's finished site could not be messaged at all.
console.log('\n13. The free site can actually be contacted');

// renderSite is already imported above; only these two are new here.
const siteAction = (await import('file:///C:/Users/Chris/killswitch/api/site-action.js')).default;
const { SITE_DEFAULT } = await import('file:///C:/Users/Chris/killswitch/lib/sites.js');

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

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
