// K6 EXECUTION tests — K5 drafted prospects reach the real outbound path
// (SIMULATED — no real provider, no real send).
//
// The K6 control plane (eligibility, durable effects, atomic caps, lease,
// bounded retry) is covered by k6-outreach.mjs / outreach-effects.mjs. This
// file covers what this slice added: drafted prospects (ks:disc:cands,
// draftStatus 'drafted') as candidates of runPostcardOutreach, end to end
// through the EXISTING sendPostcard/Lob adapter with a stubbed provider:
// gating, eligibility recheck, one-send invariants, caps, retry/dead-letter,
// terminal lock, cron auth, and the no-publish draft boundary.

process.env.KV_REST_API_URL = 'https://kv.k6exec.test';
process.env.KV_REST_API_TOKEN = 'token';
process.env.CRON_SECRET = 'test-cron-secret';
process.env.LOB_API_KEY = 'lob_test_key';
process.env.KS_FROM_NAME = 'Killswitch Websites';
process.env.KS_FROM_LINE1 = '123 Main St';
process.env.KS_FROM_CITY = 'Kansas City';
process.env.KS_FROM_STATE = 'KS';
process.env.KS_FROM_ZIP = '64108';
delete process.env.VERCEL_ENV;

import { setupKvStub, clearKvStub } from './helpers/k6-kv.mjs';

const { KV, EXP } = setupKvStub();

let lobCalls = [];
const defaultLob = async () => ({ ok: true, status: 200, json: async () => ({ id: 'psc_sim_' + lobCalls.length }) });
let lobBehavior = defaultLob;
const kvFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u === 'https://api.lob.com/v1/postcards') {
    const params = new URLSearchParams(options.body);
    lobCalls.push({
      idempotency: options.headers && options.headers['Idempotency-Key'],
      front: params.get('front') || '',
      back: params.get('back') || '',
    });
    return lobBehavior();
  }
  return kvFetch(url, options);
};

const { runPostcardOutreach, draftedProspectCandidates, CFG_KEY } = await import('../lib/k6-outreach.js');
const {
  acquireLease, releaseLease, updateEffect, getRunEffects, getStatusCounts, STATUS,
} = await import('../lib/outreach-effects.js');
const { upsertAccount } = await import('../lib/store.js');
const { suppressContact } = await import('../lib/suppression.js');
const { getSite, upsertSite } = await import('../lib/sites.js');
const cronHandler = (await import('../api/cron-mail.js')).default;

let pass = 0, fail = 0;
const check = (name, condition, detail = '') => {
  if (condition) { console.log('  PASS  ' + name); pass++; }
  else { console.log('  FAIL  ' + name + (detail ? '  <- ' + detail : '')); fail++; }
};

const ARMED = {
  enabled: true, mode: 'test', channels: ['postcard'],
  perRunCap: 5, dailyCap: 10, lifetimeCap: 20, perRunSpendCap: 1000, dailySpendCap: 2000,
};

const CANDS_KEY = 'ks:disc:cands';

function seed(cfg = ARMED) {
  KV.clear();
  EXP.clear();
  lobCalls = [];
  lobBehavior = defaultLob;
  if (cfg) KV.set(CFG_KEY, JSON.stringify(cfg));
}

function seedCandidate(cand) {
  const h = KV.get(CANDS_KEY) || {};
  h[cand.placeId] = JSON.stringify({ status: 'ranked', score: 80, ...cand });
  KV.set(CANDS_KEY, h);
}

let phoneSeq = 100;
const drafted = (placeId, over = {}) => ({
  placeId,
  name: 'Drafted ' + placeId,
  category: 'plumber',
  street: '1 Main St', city: 'Kansas City', state: 'MO', zip: '64108',
  phone: '(913) 555-0' + (phoneSeq++),
  hours: [],
  draftStatus: 'drafted',
  draftSlug: 'drafted-' + placeId,
  ...over,
});

const seedDraftSite = (cand, over = {}) => upsertSite({
  slug: cand.draftSlug, business: cand.name, city: cand.city, state: cand.state,
  phone: cand.phone, modules: ['P0'], claimed: false, published: false, ...over,
});

function mkres() {
  const r = { code: 0, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (o) => { r.body = o; return r; };
  return r;
}
async function callCron(headers = {}) {
  const res = mkres();
  await cronHandler({ method: 'GET', headers, query: {} }, res);
  return res;
}

console.log('\nUNARMED CONFIG: DRAFTED PROSPECT, ZERO SEND');
seed(null);
seedCandidate(drafted('p0'));
let r = await runPostcardOutreach({});
check('missing config: not armed, no provider call', r.ran === false && r.reason === 'not_armed' && lobCalls.length === 0);
let counts = await getStatusCounts();
check('no effect was reserved while unarmed', Object.keys(counts).length === 0);

console.log('\nCRON AUTH FAILS CLOSED WITH DRAFTED PROSPECTS QUEUED');
seed();
seedCandidate(drafted('p1'));
let cr = await callCron();
check('no Authorization: 401, no provider call', cr.code === 401 && lobCalls.length === 0);
cr = await callCron({ authorization: 'Bearer wrong' });
check('wrong bearer: 401, no provider call', cr.code === 401 && lobCalls.length === 0);
cr = await callCron({ authorization: 'Bearer test-cron-secret' });
check('correct bearer runs and sends the eligible drafted prospect', cr.code === 200 && cr.body.sent === 1 && lobCalls.length === 1);

console.log('\nINELIGIBLE DRAFTED PROSPECTS: ZERO PROVIDER CALL');
seed();
const sup = drafted('p2');
seedCandidate(sup);
await suppressContact({ phone: sup.phone }, { reason: 'stop', actor: 'test' });
r = await runPostcardOutreach({});
check('suppressed drafted prospect: no send, no effect', r.sent === 0 && lobCalls.length === 0 && Object.keys(await getStatusCounts()).length === 0);

seed();
const paid = drafted('p3');
seedCandidate(paid);
await upsertAccount({ email: 'owner@p3.test', phone: paid.phone, plan: ['P1'], stripeCustomerId: 'cus_p3' });
r = await runPostcardOutreach({});
check('paid-customer drafted prospect: no send, no effect', r.sent === 0 && lobCalls.length === 0 && Object.keys(await getStatusCounts()).length === 0);

seed();
const claimed = drafted('p4');
seedCandidate(claimed);
await upsertSite({ slug: 'claimed-p4', business: claimed.name, city: claimed.city, state: claimed.state, claimed: true, published: true, modules: ['P0'] });
r = await runPostcardOutreach({});
check('claimed-site drafted prospect: no send, no effect', r.sent === 0 && lobCalls.length === 0 && Object.keys(await getStatusCounts()).length === 0);

console.log('\nELIGIBLE DRAFTED PROSPECT: ONE SEND THROUGH THE EXISTING PATH (SIMULATED)');
seed();
const good = drafted('p10');
seedCandidate(good);
await seedDraftSite(good);
r = await runPostcardOutreach({});
check('the run sent exactly one card', r.ran === true && r.sent === 1 && lobCalls.length === 1, JSON.stringify(r.run || {}));
check('the provider call carried the durable Idempotency-Key', typeof lobCalls[0].idempotency === 'string' && /^oe-[a-f0-9]{32}:0$/.test(lobCalls[0].idempotency), lobCalls[0].idempotency);
check('the card is the existing plain offer, not a delivery claim', lobCalls[0].front.includes('Claim your') && !lobCalls[0].front.includes('already built'));
check('the card never references the unpublished draft', !lobCalls[0].front.includes(good.draftSlug) && !lobCalls[0].back.includes(good.draftSlug));
let effects = (await getRunEffects(r.run.id)).effects;
check('exactly one effect, accepted with provider ref and one attempt', effects.length === 1 && effects[0].status === STATUS.ACCEPTED && effects[0].providerRef === 'psc_sim_1' && effects[0].attempts === 1);
check('the effect snapshot ties the send to the draft and the placeId', effects[0].lead.draftSlug === good.draftSlug && effects[0].lead.placeId === good.placeId && effects[0].canonicalId === good.placeId);
check('the effect records the fresh eligibility verdict', effects[0].eligibility && effects[0].eligibility.eligible === true);
const siteAfter = await getSite(good.draftSlug);
check('the draft stays unpublished, unclaimed, unmodified', siteAfter.published === false && siteAfter.claimed === false && JSON.stringify(siteAfter.modules) === JSON.stringify(['P0']));

console.log('\nRUN TWICE: ONE SEND, ONE EFFECT, ONE CAP RESERVATION');
r = await runPostcardOutreach({});
check('second run sends nothing', r.sent === 0 && lobCalls.length === 1);
const rerun = await getRunEffects(r.run.id);
check('still one effect and one cap reservation', rerun.effects.length === 1 && rerun.rc === 1);

console.log('\nCONCURRENT RUNS: ONE SEND TOTAL');
seed();
seedCandidate(drafted('p11'));
const [c1, c2] = await Promise.all([runPostcardOutreach({}), runPostcardOutreach({})]);
check('one runner held the lease, the other was refused', (c1.ran !== c2.ran) && ((c1.reason === 'lease_held') || (c2.reason === 'lease_held')));
check('exactly one provider call across both runners', (c1.sent + c2.sent) === 1 && lobCalls.length === 1);

console.log('\nCAP BOUNDARIES BIND DRAFTED PROSPECTS');
seed({ ...ARMED, perRunCap: 1 });
seedCandidate(drafted('p20'));
seedCandidate(drafted('p21'));
r = await runPostcardOutreach({});
check('per-run cap: exactly one send, cap stop recorded', r.sent === 1 && r.run.capStop === 'per_run_cap' && lobCalls.length === 1);

seed({ ...ARMED, dailyCap: 1 });
seedCandidate(drafted('p22'));
seedCandidate(drafted('p23'));
r = await runPostcardOutreach({});
check('daily cap: first run sends one', r.sent === 1 && lobCalls.length === 1);
r = await runPostcardOutreach({});
check('daily cap: second run reserves nothing more', r.sent === 0 && lobCalls.length === 1 && r.run.capStop === 'DAILY_CAP_REACHED');

seed({ ...ARMED, perRunSpendCap: 50 });
seedCandidate(drafted('p24'));
r = await runPostcardOutreach({});
check('spend cap below one card: zero sends, zero effects', r.sent === 0 && lobCalls.length === 0 && r.run.capStop === 'RUN_SPEND_CAP_REACHED' && Object.keys(await getStatusCounts()).length === 0);

console.log('\nPROVIDER TIMEOUT: UNKNOWN, BOUNDED RETRY, SAME KEY, THEN DEAD (SIMULATED)');
seed();
seedCandidate(drafted('p30'));
lobBehavior = async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };
r = await runPostcardOutreach({});
check('timeout leaves the effect unknown after one attempt', r.sent === 0 && r.run.unknown === 1 && lobCalls.length === 1);
const keyT = lobCalls[0].idempotency;
r = await runPostcardOutreach({});
check('retry one used the SAME provider idempotency key', lobCalls.length === 2 && lobCalls[1].idempotency === keyT);
r = await runPostcardOutreach({});
check('the bounded ceiling is exactly three attempts', lobCalls.length === 3 && lobCalls[2].idempotency === keyT);
effects = (await getRunEffects(r.run.id)).effects;
check('the effect is dead with the timeout as terminal reason', effects.length === 1 && effects[0].status === STATUS.DEAD && effects[0].terminalReason === 'provider_timeout' && effects[0].attempts === 3);
lobBehavior = defaultLob;
r = await runPostcardOutreach({});
check('a dead effect never resurrects, even with a healthy provider', r.sent === 0 && lobCalls.length === 3);

console.log('\nPROVIDER PERMANENT REJECTION: DEAD-LETTER, NO RETRY SPEND (SIMULATED)');
seed();
seedCandidate(drafted('p31'));
lobBehavior = async () => ({ ok: false, status: 422, json: async () => ({ error: { message: 'address undeliverable', code: 'failed_deliverability_strictness' } }) });
r = await runPostcardOutreach({});
check('a permanent rejection dead-letters on the first attempt', r.sent === 0 && r.run.dead === 1 && lobCalls.length === 1);
effects = (await getRunEffects(r.run.id)).effects;
check('the terminal reason is the bad address', effects[0].status === STATUS.DEAD && effects[0].terminalReason === 'bad_address');
r = await runPostcardOutreach({});
check('no retry is attempted for a dead effect', lobCalls.length === 1);

console.log('\nTERMINAL LOCK: AN ACCEPTED EFFECT CANNOT BE REWRITTEN');
seed();
seedCandidate(drafted('p40'));
r = await runPostcardOutreach({});
check('setup send accepted', r.sent === 1);
const accepted = (await getRunEffects(r.run.id)).effects[0];
await acquireLease('locktest', 60000);
const locked = await updateEffect({ owner: 'locktest', effectId: accepted.effectId, patch: { status: STATUS.RESERVED, attempts: 0 } });
check('rewriting an accepted effect is refused', locked.ok === false && locked.status === 'TERMINAL_LOCKED');
const stillAccepted = (await getRunEffects(r.run.id)).effects[0];
check('the accepted record is untouched', stillAccepted.status === STATUS.ACCEPTED && stillAccepted.providerRef === 'psc_sim_1');
await releaseLease('locktest');

console.log('\nMIXED SOURCES: LEGACY QUEUE + DRAFTED, DEDUPED BY IDENTITY');
seed();
KV.set('ks:leads', JSON.stringify([{ id: 'legacy-1', name: 'Legacy One', business: 'Legacy One', street: '2 Main St', city: 'Kansas City', state: 'MO', zip: '64108' }]));
seedCandidate(drafted('p50'));
seedCandidate(drafted('legacy-1', { name: 'Legacy One' }));
r = await runPostcardOutreach({});
check('legacy lead and drafted prospect both send', r.sent === 2 && lobCalls.length === 2);
effects = (await getRunEffects(r.run.id)).effects;
check('exactly two effects: the shared identity produced no second effect', effects.length === 2
  && effects.filter((e) => e.leadId === 'legacy-1').length === 1
  && effects.filter((e) => e.leadId === 'p50').length === 1);

console.log('\nSELECTOR: ONLY DRAFTED PROSPECTS WITH A MAILABLE ADDRESS QUALIFY');
seed();
seedCandidate(drafted('p60'));
seedCandidate({ ...drafted('p61'), draftStatus: '' });
seedCandidate({ ...drafted('p62'), draftSlug: '' });
seedCandidate({ ...drafted('p63'), street: '' });
const sel = await draftedProspectCandidates();
check('only the fully drafted, mailable prospect is selected', sel.length === 1 && sel[0].placeId === 'p60');
check('the selected lead carries placeId and draftSlug but no siteSlug', sel[0].draftSlug === 'drafted-p60' && sel[0].placeId === 'p60' && !('siteSlug' in sel[0]));

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
clearKvStub();
process.exit(fail ? 1 : 0);
