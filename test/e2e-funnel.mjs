// FULL FUNNEL E2E — SIMULATED providers, real modules, real durable state.
//
// One prospect walks the whole product:
//   K4 ranked candidate (seeded at the discovery output boundary)
//   -> K5 runDraftAutonomy        (unpublished draft, placeId-linked)
//   -> K6 runPostcardOutreach     (eligibility recheck, effect reservation, Lob)
//   -> /api/inbound claim          (draft claimed, account, welcome mail, reminder queued)
//   -> /api/stripe-webhook paid    (signed test event, P1 provisioned onto the site)
//   -> follow-up drain             (paid owner: reminder terminally stands down)
//
// Then THE WHOLE THING AGAIN: no second draft, no second postcard, no second
// account, webhook replay is a no-op, the reminder never duplicates.
//
// Failure recovery at chain level: provider timeout retries with the SAME
// idempotency key through crash-window (attempting) residue; a prospect
// suppressed mid-flow never reaches the provider; concurrent crons send once.
//
// KV, Lob, Resend and Stripe are in-memory stubs. Nothing real was sent or
// charged. The stub speaks every KV command these paths use plus the
// production EVAL semantics of the K5 draft and K6 outreach scripts.

process.env.KV_REST_API_URL = 'https://kv.e2e.test';
process.env.KV_REST_API_TOKEN = 'token';
process.env.LOB_API_KEY = 'lob_test_key';
process.env.KS_FROM_NAME = 'Killswitch Websites';
process.env.KS_FROM_LINE1 = '123 Main St';
process.env.KS_FROM_CITY = 'Kansas City';
process.env.KS_FROM_STATE = 'KS';
process.env.KS_FROM_ZIP = '64108';
process.env.RESEND_API_KEY = 're_stub';
process.env.KS_NOTIFY_EMAIL = 'ops@killswitch.test';
process.env.KS_PANEL_SECRET = 'panel-test-secret';
process.env.STRIPE_SECRET_KEY = 'sk_test_stub';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_e2e_secret';
delete process.env.VERCEL_ENV;

import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// In-memory KV with the command set + EVAL semantics the funnel uses.
const KV = new Map();
const EXP = new Map();
const live = (key) => { if (EXP.has(key) && EXP.get(key) <= Date.now()) { EXP.delete(key); KV.delete(key); } };
const get = (key) => { live(key); return KV.has(key) ? KV.get(key) : null; };
const set = (key, value) => { KV.set(key, value); };

function kvRun(a) {
  const [cmd, key, f, v] = a;
  if (cmd === 'GET') return get(key);
  if (cmd === 'SET') {
    const flags = a.slice(3);
    const nx = flags.includes('NX');
    live(key);
    if (nx && KV.has(key)) return null;
    set(key, a[2]);
    const pi = flags.indexOf('PX'), ei = flags.indexOf('EX');
    if (pi > -1) EXP.set(key, Date.now() + Number(flags[pi + 1]));
    if (ei > -1) EXP.set(key, Date.now() + Number(flags[ei + 1]) * 1000);
    return 'OK';
  }
  if (cmd === 'HSET') { const h = get(key) || {}; h[f] = v; set(key, h); return 1; }
  if (cmd === 'HSETNX') { const h = get(key) || {}; if (h[f] !== undefined) return 0; h[f] = v; set(key, h); return 1; }
  if (cmd === 'HGET') { const h = get(key) || {}; return h[f] == null ? null : h[f]; }
  if (cmd === 'HGETALL') { const h = get(key) || {}; const flat = []; for (const [k, val] of Object.entries(h)) flat.push(k, val); return flat; }
  if (cmd === 'HKEYS') return Object.keys(get(key) || {});
  if (cmd === 'HDEL') { const h = get(key) || {}; delete h[f]; set(key, h); return 1; }
  if (cmd === 'INCR') { const n = Number(get(key) || 0) + 1; set(key, String(n)); return n; }
  if (cmd === 'DEL') { KV.delete(key); EXP.delete(key); return 1; }
  if (cmd === 'EXPIRE') return 1;
  if (cmd === 'ZADD') {
    const z = get(key) || {};
    const nx = a[2] === 'NX';
    const score = Number(nx ? a[3] : a[2]);
    const member = nx ? a[4] : a[3];
    if (nx && z[member] !== undefined) return 0;
    z[member] = score; set(key, z); return 1;
  }
  if (cmd === 'ZREM') { const z = get(key) || {}; delete z[f]; set(key, z); return 1; }
  if (cmd === 'ZRANGE') {
    const z = get(key) || {};
    return Object.keys(z).sort((x, y) => z[x] - z[y]);
  }
  if (cmd === 'ZRANGEBYSCORE') {
    const z = get(key) || {};
    const max = Number(a[3]);
    let out = Object.keys(z).filter((m) => z[m] <= max).sort((x, y) => z[x] - z[y]);
    const li = a.indexOf('LIMIT');
    if (li > -1) out = out.slice(Number(a[li + 1]), Number(a[li + 1]) + Number(a[li + 2]));
    return out;
  }
  if (cmd === 'EVAL') return evalScript(a);
  throw new Error('unexpected kv cmd ' + cmd);
}

function evalScript(a) {
  const script = a[1];
  const n = Number(a[2]);
  const keys = a.slice(3, 3 + n);
  const argv = a.slice(3 + n);
  const leaseOk = () => get(keys[0]) === argv[0];

  if (script.includes('outreach_reserve_v1')) {
    const [owner, effectId, effectJSON, runId, day, canonicalId, perRunCap, dailyCap, lifetimeCap, perRunSpendCap, dailySpendCap, costCents] = argv;
    if (!leaseOk()) return 'LEASE_LOST';
    const checkInt = (s) => { const num = Number(s); return Number.isFinite(num) && num === Math.floor(num) && num > 0; };
    if (![perRunCap, dailyCap, lifetimeCap, perRunSpendCap, dailySpendCap].every(checkInt)) return 'INVALID_CAP';
    const effects = get(keys[1]) || {};
    if (effects[effectId] !== undefined) return ['EXISTS', effects[effectId]];
    const counter = (k) => {
      const raw = get(k);
      if (raw == null) return 0;
      const num = Number(raw);
      if (!Number.isFinite(num) || num !== Math.floor(num) || num < 0) return 'CORRUPT';
      return num;
    };
    const vals = keys.slice(2, 7).map(counter);
    if (vals.includes('CORRUPT')) return 'CORRUPT_COUNTER';
    const [rc, dc, lc, rsc, dsc] = vals;
    if (rc >= Number(perRunCap)) return 'RUN_CAP_REACHED';
    if (dc >= Number(dailyCap)) return 'DAILY_CAP_REACHED';
    if (lc >= Number(lifetimeCap)) return 'LIFETIME_CAP_REACHED';
    const cost = Number(costCents) || 0;
    if (rsc + cost > Number(perRunSpendCap)) return 'RUN_SPEND_CAP_REACHED';
    if (dsc + cost > Number(dailySpendCap)) return 'DAILY_SPEND_CAP_REACHED';
    set(keys[2], String(rc + 1)); set(keys[3], String(dc + 1)); set(keys[4], String(lc + 1));
    if (cost > 0) { set(keys[5], String(rsc + cost)); set(keys[6], String(dsc + cost)); }
    effects[effectId] = effectJSON; set(keys[1], effects);
    return ['OK', effectId];
  }

  if (script.includes('outreach_update_v1')) {
    const [owner, effectId, patchJSON] = argv;
    if (!leaseOk()) return 'LEASE_LOST';
    const effects = get(keys[1]) || {};
    const cur = effects[effectId];
    if (cur !== undefined) {
      let parsed;
      try { parsed = JSON.parse(cur); } catch { return 'CORRUPT_EFFECT'; }
      if (!parsed || typeof parsed !== 'object' || typeof parsed.status !== 'string') return 'CORRUPT_EFFECT';
      const VALID = ['reserved', 'attempting', 'accepted', 'retryable', 'unknown', 'dead', 'rejected'];
      if (!VALID.includes(parsed.status)) return 'CORRUPT_EFFECT';
      if (['accepted', 'dead', 'rejected'].includes(parsed.status)) return 'TERMINAL_LOCKED';
    }
    effects[effectId] = patchJSON; set(keys[1], effects);
    return 'OK';
  }

  if (script.includes('outreach_complete_v1')) {
    if (!leaseOk()) return 'LEASE_LOST';
    const runs = get(keys[1]) || {}; runs[argv[1]] = argv[2]; set(keys[1], runs);
    return 'OK';
  }

  if (script.includes('draft_apply_v1')) {
    // KEYS: 1=lease, 2=site body, 3=siteidx, 4=place idx, 5=candidates, 6=effects, 7=run counter
    // ARGV: 1=owner, 2=placeId, 3=slug, 4=siteJSON, 5=indexJSON, 6=candidateJSON, 7=effectType, 8=runId, 9=draftsPerRun
    if (!leaseOk()) return 'LEASE_LOST';
    const dp = Number(argv[8]);
    if (!Number.isFinite(dp) || dp !== Math.floor(dp) || dp <= 0) return 'INVALID_CAP';
    const rcRaw = get(keys[6]);
    let rc = 0;
    if (rcRaw != null) {
      rc = Number(rcRaw);
      if (!Number.isFinite(rc) || rc !== Math.floor(rc) || rc < 0) return 'CORRUPT_COUNTER';
    }
    const placeIdx = get(keys[3]) || {};
    const siteIdx = get(keys[2]) || {};
    const existingSlug = placeIdx[argv[1]];
    if (existingSlug !== undefined) {
      if (argv[6] === 'new') return ['EXISTING', existingSlug, 'new'];
    } else {
      if (get(keys[1]) != null) return ['COLLISION', argv[2]];
      if (siteIdx[argv[2]] !== undefined) return ['COLLISION', argv[2]];
    }
    const effects = get(keys[5]) || {};
    if (argv[6] === 'new') {
      if (rc >= dp) return 'CAP_REACHED';
      set(keys[6], String(rc + 1));
      effects[argv[1]] = 'new';
    } else if (argv[6] === 'repair' && existingSlug === argv[2]) {
      if (effects[argv[1]] === undefined) effects[argv[1]] = 'repair';
    }
    set(keys[5], effects);
    set(keys[1], argv[3]);
    siteIdx[argv[2]] = argv[4]; set(keys[2], siteIdx);
    placeIdx[argv[1]] = argv[2]; set(keys[3], placeIdx);
    const cands = get(keys[4]) || {}; cands[argv[1]] = argv[5]; set(keys[4], cands);
    return ['OK', argv[2], argv[6]];
  }

  if (script.includes('draft_link_v1')) {
    if (!leaseOk()) return 'LEASE_LOST';
    const placeIdx = get(keys[1]) || {};
    const existing = placeIdx[argv[1]];
    if (existing !== undefined && existing !== argv[2]) return ['MAPPING_CONFLICT', existing];
    placeIdx[argv[1]] = argv[2]; set(keys[1], placeIdx);
    const cands = get(keys[2]) || {}; cands[argv[1]] = argv[3]; set(keys[2], cands);
    return 'OK';
  }

  if (script.includes('draft_candidate_update_v1') || script.includes('draft_repair_index_v1')) {
    if (!leaseOk()) return 'LEASE_LOST';
    const h = get(keys[1]) || {}; h[argv[1]] = argv[2]; set(keys[1], h);
    return 'OK';
  }

  if (script.includes('draft_complete_v1')) {
    if (!leaseOk()) return 'LEASE_LOST';
    const runs = get(keys[1]) || {}; runs[argv[1]] = argv[2]; set(keys[1], runs);
    return 'COMPLETED';
  }

  if (script.includes('draft_run_status_v1')) {
    if (!leaseOk()) return 'LEASE_LOST';
    const runs = get(keys[1]) || {}; runs[argv[1]] = argv[2]; set(keys[1], runs);
    return 'OK';
  }

  // Lease renew (PSETEX) and release (DEL), owner-only — shared by K5 and K6.
  if (script.includes('PSETEX')) {
    if (get(keys[0]) === argv[0]) { set(keys[0], argv[0]); EXP.set(keys[0], Date.now() + Number(argv[1])); return 'OK'; }
    return 'LOST';
  }
  if (script.includes('DEL')) {
    if (get(keys[0]) === argv[0]) { KV.delete(keys[0]); EXP.delete(keys[0]); return 1; }
    return 0;
  }

  throw new Error('unexpected EVAL script ' + script.slice(0, 40));
}

// ---------------------------------------------------------------------------
// Provider stubs.
let lobCalls = [];
let lobBehavior = null; // null = accept
let resendCalls = [];
const stripeState = {
  lineItems: { data: [] },
  subs: { data: [] },
};

globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.startsWith(process.env.KV_REST_API_URL)) {
    const args = JSON.parse(options.body);
    if (u.endsWith('/pipeline')) return { ok: true, status: 200, json: async () => args.map((x) => ({ result: kvRun(x) })) };
    return { ok: true, status: 200, json: async () => ({ result: kvRun(args) }) };
  }
  if (u === 'https://api.lob.com/v1/postcards') {
    lobCalls.push({ idempotency: options.headers && options.headers['Idempotency-Key'] });
    if (lobBehavior === 'timeout') {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    }
    return { ok: true, status: 200, json: async () => ({ id: 'psc_e2e_' + lobCalls.length }) };
  }
  if (u.startsWith('https://api.resend.com')) {
    resendCalls.push({ key: options.headers && options.headers['Idempotency-Key'], to: JSON.parse(options.body).to });
    return { ok: true, status: 200, json: async () => ({ id: 're_e2e_' + resendCalls.length }) };
  }
  if (u.startsWith('https://api.stripe.com/v1/checkout/sessions/')) {
    return { ok: true, status: 200, json: async () => stripeState.lineItems };
  }
  if (u.startsWith('https://api.stripe.com/v1/subscriptions')) {
    return { ok: true, status: 200, json: async () => stripeState.subs };
  }
  if (u.startsWith('https://api.stripe.com/v1/customers')) {
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  }
  throw new Error('unexpected fetch ' + u);
};

// ---------------------------------------------------------------------------
const { runDraftAutonomy, saveDraftConfig, getPlaceIndex } = await import('../lib/draft-autonomy.js');
const { runPostcardOutreach, saveOutreachConfig, CFG_KEY } = await import('../lib/k6-outreach.js');
const { getRunEffects, getStatusCounts, STATUS } = await import('../lib/outreach-effects.js');
const { getSite, listSites, upsertSite, slugify } = await import('../lib/sites.js');
const { getAccount } = await import('../lib/store.js');
const { suppressContact } = await import('../lib/suppression.js');
const { getCandidates } = await import('../lib/discovery.js');
const { listBillingEvents } = await import('../lib/billing-events.js');
const { getLifecycleEvents } = await import('../lib/lifecycle.js');
const { dueItems } = await import('../lib/automation.js');
const { drainFollowups } = await import('../api/cron-followups.js');
const { MONTHLY } = await import('../lib/prices.js');
const inbound = (await import('../api/inbound.js')).default;
const webhook = (await import('../api/stripe-webhook.js')).default;

let pass = 0, fail = 0;
const check = (name, condition, detail = '') => {
  if (condition) { console.log('  PASS  ' + name); pass++; }
  else { console.log('  FAIL  ' + name + (detail ? '  <- ' + detail : '')); fail++; }
};

function mkres() {
  const r = { code: 0, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (o) => { r.body = o; return r; };
  r.send = function (o) { r.body = o; return r; };
  r.setHeader = () => r;
  return r;
}

function signed(payload, secret = process.env.STRIPE_WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000)) {
  const body = Buffer.from(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(t + '.' + body.toString('utf8'), 'utf8').digest('hex');
  return { body, header: `t=${t},v1=${sig}` };
}
function rawReq(body, header) {
  const listeners = {};
  const req = {
    method: 'POST',
    headers: { 'stripe-signature': header, host: 'e2e.test' },
    on(ev, fn) { listeners[ev] = fn; return req; },
  };
  setTimeout(() => { if (listeners.data) listeners.data(body); if (listeners.end) listeners.end(); }, 0);
  return req;
}
async function hook(payload) {
  const { body, header } = signed(payload);
  const res = mkres();
  await webhook(rawReq(body, header), res);
  return res;
}

const ARMED = {
  enabled: true, mode: 'test', channels: ['postcard'],
  perRunCap: 5, dailyCap: 10, lifetimeCap: 20, perRunSpendCap: 1000, dailySpendCap: 2000,
  postcardReserveCents: 94,
};

const BUSINESS = 'Funnel Test Plumbing';
const EMAIL = 'owner@funneltest.test';
const PLACE = 'plc-e2e-1';

function seedCandidate(placeId, name, phone) {
  const h = get('ks:disc:cands') || {};
  h[placeId] = JSON.stringify({
    placeId, name, category: 'plumber', status: 'ranked', score: 88,
    street: '44 Main St', city: 'Kansas City', state: 'MO', zip: '64108',
    phone, hours: [],
  });
  set('ks:disc:cands', h);
}

// The K5 output state for a candidate, written directly: candidate marked
// drafted plus its unpublished draft site. (A second same-day draft run is
// 'caught_up' by design, so later-section prospects arrive pre-drafted.)
async function seedDraftedProspect(placeId, name, phone) {
  const h = get('ks:disc:cands') || {};
  const slug = slugify(name);
  h[placeId] = JSON.stringify({
    placeId, name, category: 'plumber', status: 'ranked', score: 88,
    street: '44 Main St', city: 'Kansas City', state: 'MO', zip: '64108',
    phone, hours: [], draftStatus: 'drafted', draftSlug: slug,
  });
  set('ks:disc:cands', h);
  await upsertSite({
    slug, business: name, city: 'Kansas City', state: 'MO', phone,
    street: '44 Main St', zip: '64108',
    modules: ['P0'], published: false, claimed: false, placeId,
  });
  return slug;
}

// ===========================================================================
console.log('\nSTAGE 1-2: RANKED CANDIDATE -> ONE UNPUBLISHED DRAFT');
seedCandidate(PLACE, BUSINESS, '(913) 555-0199');
await saveDraftConfig({ enabled: true, draftsPerRun: 2, minScore: 0 });
let dr = await runDraftAutonomy({});
check('the draft run completes with one draft', dr.ran === true && dr.drafts === 1, JSON.stringify(dr.run || dr));
const placeIdx = await getPlaceIndex();
const SLUG = placeIdx[PLACE];
check('the placeId is durably linked to one slug', typeof SLUG === 'string' && SLUG.length > 0, SLUG);
let site = await getSite(SLUG);
check('the draft is unpublished, unclaimed, free tier', site && site.published === false && site.claimed === false && JSON.stringify(site.modules) === JSON.stringify(['P0']));
const cand1 = (await getCandidates())[PLACE];
check('the candidate is marked drafted with its slug', cand1.draftStatus === 'drafted' && cand1.draftSlug === SLUG);

console.log('\nSTAGE 3: K6 OUTREACH — RECHECK, RESERVE, ONE SIMULATED SEND');
await saveOutreachConfig(ARMED);
let or = await runPostcardOutreach({});
check('one card sent for the drafted prospect', or.ran === true && or.sent === 1 && lobCalls.length === 1, JSON.stringify(or.run || {}));
const keyA = lobCalls[0].idempotency;
check('the provider call carried the durable idempotency key', /^oe-[a-f0-9]{32}:0$/.test(keyA || ''), keyA);
site = await getSite(SLUG);
check('outreach did NOT publish the draft', site.published === false && site.claimed === false);
let effects = Object.values((await getRunEffects(or.run.id)).effects);
check('one accepted effect with a provider reference', effects.length === 1 && effects[0].status === STATUS.ACCEPTED && !!effects[0].providerRef);
check('the effect ties the send to the draft and placeId', effects[0].lead.draftSlug === SLUG && effects[0].lead.placeId === PLACE);

console.log('\nSTAGE 4: CLAIM THROUGH THE REAL INBOUND DOOR');
let res = mkres();
await inbound({
  method: 'POST',
  headers: { 'x-forwarded-for': '203.0.113.9' },
  body: {
    email: EMAIL, business: BUSINESS, phone: '(913) 555-0199', trade: 'plumber',
    city: 'Kansas City', state: 'MO', street: '44 Main St', zip: '64108',
  },
}, res);
check('the claim is accepted', res.code === 200 && res.body.ok === true, res.code + ' ' + JSON.stringify(res.body));
check('the customer landed on the SAME site the draft built', res.body.siteUrl === 'https://killswitchwebsites.com/s/' + SLUG, res.body.siteUrl);
site = await getSite(SLUG);
check('the site is now published and claimed', site.published === true && site.claimed === true && site.email === EMAIL);
let account = await getAccount(EMAIL);
check('one free account exists for the owner', account && JSON.stringify(account.plan) === JSON.stringify(['P0']));
check('the welcome mail went out once', resendCalls.filter((c) => c.to && c.to.includes(EMAIL)).length === 1);
const reminderDue = await dueItems(Date.now() + 4 * 86400000);
check('exactly one claim reminder is queued', reminderDue.filter((i) => i.step === 'claimremind').length === 1);

console.log('\nSTAGE 5: STRIPE TEST PAYMENT -> PAID PROVISIONING');
stripeState.lineItems = { data: [{ price: { id: MONTHLY.P1 }, description: 'Get Found on Google' }] };
stripeState.subs = { data: [{ id: 'sub_e2e_1', status: 'active', items: { data: [{ price: { id: MONTHLY.P1 } }] } }] };
const EVENT = {
  id: 'evt_e2e_1', type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000),
  data: { object: {
    id: 'cs_e2e_1', mode: 'subscription', payment_status: 'paid', customer: 'cus_e2e_1',
    customer_details: { email: EMAIL, name: BUSINESS }, amount_total: 1900, currency: 'usd',
  } },
};
res = await hook(EVENT);
check('the signed webhook is accepted', res.code === 200, res.code + ' ' + JSON.stringify(res.body));
account = await getAccount(EMAIL);
check('the account is linked to the Stripe customer', account.stripeCustomerId === 'cus_e2e_1');
site = await getSite(SLUG);
check('P1 is provisioned onto the customer site', site.modules.includes('P1'), JSON.stringify(site.modules));
check('the payment lifecycle event landed once',
  (await getLifecycleEvents(EMAIL)).filter((e) => e.type === 'payment.completed').length === 1);
check('the billing ledger recorded the payment',
  (await listBillingEvents(50)).some((b) => b.type === 'payment.completed' && b.id === 'evt_e2e_1'));

console.log('\nSTAGE 6: FOLLOW-UP STATE — A PAID OWNER IS NEVER NUDGED');
const q = get('ks:auto:q') || {};
for (const k of Object.keys(q)) q[k] = Date.now() - 1000;
set('ks:auto:q', q);
const resendBeforeDrain = resendCalls.length;
const drain = await drainFollowups();
check('the claim reminder stands down terminally as paid', drain.body.skipped >= 1 && drain.body.reasons.paid === 1, JSON.stringify(drain.body));
check('no reminder email was sent', resendCalls.length === resendBeforeDrain);
check('the reminder is retired, not requeued', (await dueItems(Date.now() + 10 * 86400000)).filter((i) => i.step === 'claimremind').length === 0);

// ===========================================================================
console.log('\nRUN THE WHOLE THING AGAIN: ONE EFFECTIVE EFFECT PER STAGE');
dr = await runDraftAutonomy({});
check('second draft run: caught up, no second draft', dr.ran === false || dr.drafts === 0, JSON.stringify(dr.run || dr));
check('still exactly one site for the business', (await listSites()).filter((s) => s.slug === SLUG).length === 1);

or = await runPostcardOutreach({});
check('second outreach run sends nothing (claimed customer + accepted effect)', or.sent === 0 && lobCalls.length === 1);

res = mkres();
await inbound({
  method: 'POST',
  headers: { 'x-forwarded-for': '203.0.113.9' },
  body: { email: EMAIL, business: BUSINESS, phone: '(913) 555-0199', trade: 'plumber', city: 'Kansas City', state: 'MO', street: '44 Main St', zip: '64108' },
}, res);
check('a repeat signup succeeds against the same site', res.code === 200 && res.body.siteUrl.endsWith('/s/' + SLUG));
const account2 = await getAccount(EMAIL);
check('the account was not reset or duplicated', account2.createdAt === account.createdAt && account2.stripeCustomerId === 'cus_e2e_1');
check('no second claim reminder stacked', (await dueItems(Date.now() + 4 * 86400000)).filter((i) => i.step === 'claimremind').length === 0);

const billingBefore = (await listBillingEvents(50)).length;
res = await hook(EVENT);
check('the replayed webhook is a durable no-op', res.code === 200 && res.body.duplicate === true, JSON.stringify(res.body));
check('no second billing event, no reprovisioning', (await listBillingEvents(50)).length === billingBefore
  && JSON.stringify((await getSite(SLUG)).modules) === JSON.stringify(site.modules));
check('payment.completed lifecycle is still singular',
  (await getLifecycleEvents(EMAIL)).filter((e) => e.type === 'payment.completed').length === 1);

// ===========================================================================
console.log('\nFAILURE RECOVERY AT CHAIN LEVEL (SIMULATED)');

console.log('\nPROVIDER TIMEOUT -> SAME-KEY RETRY THROUGH CRASH RESIDUE -> ACCEPTED');
await seedDraftedProspect('plc-e2e-2', 'Timeout Test Roofing', '(913) 555-0177');
lobBehavior = 'timeout';
or = await runPostcardOutreach({});
check('the timeout leaves one unknown effect, nothing sent', or.sent === 0 && or.run.unknown === 1);
const effT = (await getRunEffects(or.run.id)).effects.find((e) => e.leadId === 'plc-e2e-2');
check('the effect is durably unknown with the reservation intact', effT && effT.status === STATUS.UNKNOWN && effT.attempts === 1);
const keyT = lobCalls[lobCalls.length - 1].idempotency;
const rcBeforeRetry = (await getRunEffects(or.run.id)).rc;
// Simulate the crash window: the worker died between ATTEMPTING and the outcome
// write. The same effect must resume, never reserve a second one.
const { acquireLease, releaseLease, updateEffect } = await import('../lib/outreach-effects.js');
await acquireLease('crash-sim', 60000);
await updateEffect({ owner: 'crash-sim', effectId: effT.effectId, patch: { status: STATUS.ATTEMPTING } });
await releaseLease('crash-sim');
lobBehavior = null;
or = await runPostcardOutreach({});
check('the retry resumes the SAME effect and accepts', or.sent === 1);
check('the retry reused the SAME provider idempotency key', lobCalls[lobCalls.length - 1].idempotency === keyT);
const effT2 = (await getRunEffects(or.run.id)).effects.find((e) => e.leadId === 'plc-e2e-2');
check('the effect is accepted with two attempts and consumed NO new reservation', effT2.status === STATUS.ACCEPTED && effT2.attempts === 2
  && (await getRunEffects(or.run.id)).rc === rcBeforeRetry,
  JSON.stringify({ status: effT2.status, attempts: effT2.attempts, rc: (await getRunEffects(or.run.id)).rc, before: rcBeforeRetry }));

console.log('\nSUPPRESSED MID-FLOW: ZERO PROVIDER CALL, NO EFFECT');
await seedDraftedProspect('plc-e2e-3', 'Suppressed Midflow Electric', '(913) 555-0163');
const cands3 = await getCandidates();
check('the prospect is drafted and selectable before the stop arrives', cands3['plc-e2e-3'].draftStatus === 'drafted');
await suppressContact({ phone: '9135550163' }, { reason: 'stop', actor: 'e2e' });
const lobBefore = lobCalls.length;
or = await runPostcardOutreach({});
check('a suppressed prospect never reaches the provider', or.sent === 0 && lobCalls.length === lobBefore);
check('no effect was reserved for the suppressed prospect',
  !(await getRunEffects(or.run.id)).effects.some((e) => e.leadId === 'plc-e2e-3'));

console.log('\nDUPLICATE CRON: CONCURRENT RUNNERS, ONE WINNER');
const [p1, p2] = await Promise.all([runPostcardOutreach({}), runPostcardOutreach({})]);
check('one runner holds the lease, the other stands down', (p1.ran !== p2.ran) && (p1.reason === 'lease_held' || p2.reason === 'lease_held'));
check('no duplicate sends across the race', lobCalls.length === lobBefore);

console.log('\nFINAL LEDGER SHAPE');
const counts = await getStatusCounts();
check('every effect is terminal: two accepted, nothing left open',
  counts[STATUS.ACCEPTED] === 2 && !counts[STATUS.RESERVED] && !counts[STATUS.ATTEMPTING] && !counts[STATUS.UNKNOWN] && !counts[STATUS.RETRYABLE], JSON.stringify(counts));

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
