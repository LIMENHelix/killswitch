// K6 run-level tests for lib/k6-outreach.js (SIMULATED — no real provider).
//
// Exercises the full control plane: armed/unarmed config gating, the lease,
// durable effect reservation, caps, bounded retry with a stable provider
// idempotency key, terminal classification, stale-eligibility re-derivation,
// and the K5 no-implicit-publish boundary. KV and Lob are in-memory stubs.

process.env.KV_REST_API_URL = 'https://kv.k6run.test';
process.env.KV_REST_API_TOKEN = 'token';
process.env.LOB_API_KEY = 'lob_test_key';
process.env.KS_FROM_NAME = 'Sunflower Websites';
process.env.KS_FROM_LINE1 = '123 Main St';
process.env.KS_FROM_CITY = 'Kansas City';
process.env.KS_FROM_STATE = 'KS';
process.env.KS_FROM_ZIP = '64108';
delete process.env.VERCEL_ENV;

import { setupKvStub, clearKvStub } from './helpers/k6-kv.mjs';

const { KV, EXP } = setupKvStub();

let lobCalls = [];
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
    return { ok: true, status: 200, json: async () => ({ id: 'psc_stub_' + lobCalls.length }) };
  }
  return kvFetch(url, options);
};

const {
  runOutreach, validateOutreachConfigPatch, outreachConfigArmable, CFG_KEY,
} = await import('../lib/k6-outreach.js');
const {
  acquireLease, releaseLease, getEffect, getRunEffects, getStatusCounts, reserveEffect, STATUS,
} = await import('../lib/outreach-effects.js');
const { sendPostcard } = await import('../lib/mailer.js');
const { upsertAccount } = await import('../lib/store.js');
const { suppressContact } = await import('../lib/suppression.js');
const { getSite, upsertSite } = await import('../lib/sites.js');

let pass = 0, fail = 0;
const check = (name, condition, detail = '') => {
  if (condition) { console.log('  PASS  ' + name); pass++; }
  else { console.log('  FAIL  ' + name + (detail ? '  <- ' + detail : '')); fail++; }
};

const ARMED = {
  enabled: true, mode: 'test', channels: ['postcard'],
  perRunCap: 5, dailyCap: 10, lifetimeCap: 20, perRunSpendCap: 1000, dailySpendCap: 2000,
  postcardReserveCents: 94,
};

function seed(cfg = ARMED) {
  KV.clear();
  EXP.clear();
  lobCalls = [];
  if (cfg) KV.set(CFG_KEY, JSON.stringify(cfg));
}

const lead = (id, overrides = {}) => ({
  id, name: 'Shop ' + id, business: 'Shop ' + id,
  street: '1 Main St', city: 'Kansas City', state: 'MO', zip: '64108',
  ...overrides,
});

// A scripted adapter: records every invocation, plays queued outcomes per lead.
function stubAdapter(outcomes, calls) {
  return async ({ lead, idempotencyKey, attempt }) => {
    const entry = { leadId: lead.id, idempotencyKey, attempt };
    calls.push(entry);
    const queue = outcomes[lead.id] || [{ ok: true, providerRef: 'psc_' + lead.id }];
    const out = queue.length > 1 ? queue.shift() : queue[0];
    return { spend: 0, ...out };
  };
}

console.log('\nCONFIG GATING FAILS CLOSED');
seed(null);
let calls = [];
let r = await runOutreach({ channel: 'postcard', selectCandidates: async () => [lead('a')], channelAdapter: stubAdapter({}, calls) });
check('missing config: no run, no provider call', r.ran === false && r.reason === 'not_armed' && calls.length === 0);

seed({ ...ARMED, enabled: false });
r = await runOutreach({ channel: 'postcard', selectCandidates: async () => [lead('a')], channelAdapter: stubAdapter({}, calls) });
check('disabled config: no run, no provider call', r.ran === false && r.reason === 'not_armed' && calls.length === 0);

seed({ ...ARMED, perRunCap: 0 });
r = await runOutreach({ channel: 'postcard', selectCandidates: async () => [lead('a')], channelAdapter: stubAdapter({}, calls) });
check('zero cap config: no run, no provider call', r.ran === false && r.reason === 'not_armed' && calls.length === 0);

seed({ ...ARMED, channels: ['email'] });
r = await runOutreach({ channel: 'postcard', selectCandidates: async () => [lead('a')], channelAdapter: stubAdapter({}, calls) });
check('an unsupported channel list is not armable: no provider call', r.ran === false && r.reason === 'not_armed' && calls.length === 0);

console.log('\nCONFIG VALIDATION IS STRICT');
let v = validateOutreachConfigPatch({}, { enabled: true, mode: 'test', channels: ['postcard'], perRunCap: 1, dailyCap: 1, lifetimeCap: 1, perRunSpendCap: 1, dailySpendCap: 1, postcardReserveCents: 94 });
check('a complete valid config arms', !v.error && outreachConfigArmable(v.config));
v = validateOutreachConfigPatch({}, { enabled: true, mode: 'test', channels: ['postcard'], perRunCap: 1, dailyCap: 1, lifetimeCap: 1, perRunSpendCap: 1, dailySpendCap: 1 });
check('enabled without a per-card reserve is rejected', v.error === 'incomplete_config');
v = validateOutreachConfigPatch({}, { postcardReserveCents: 94.5 });
check('a fractional reserve is rejected, not floored', v.error === 'invalid_config');
v = validateOutreachConfigPatch({}, { enabled: true, mode: 'test', channels: ['postcard'], perRunCap: 0, dailyCap: 1, lifetimeCap: 1, perRunSpendCap: 1, dailySpendCap: 1 });
check('enabled with a zero cap is rejected', v.error === 'incomplete_config');
v = validateOutreachConfigPatch({}, { perRunCap: 2.5 });
check('a fractional cap is rejected, not floored', v.error === 'invalid_config');
v = validateOutreachConfigPatch({}, { dailyCap: -3 });
check('a negative cap is rejected', v.error === 'invalid_config');
v = validateOutreachConfigPatch({}, { lifetimeCap: 'abc' });
check('a non-numeric cap is rejected', v.error === 'invalid_config');
v = validateOutreachConfigPatch({}, { enabled: true, mode: 'test', channels: ['smoke-signals'], perRunCap: 1, dailyCap: 1, lifetimeCap: 1, perRunSpendCap: 1, dailySpendCap: 1 });
check('an unsupported channel cannot arm', v.error === 'incomplete_config');
v = validateOutreachConfigPatch({}, { enabled: true, mode: 'yolo', channels: ['postcard'], perRunCap: 1, dailyCap: 1, lifetimeCap: 1, perRunSpendCap: 1, dailySpendCap: 1 });
check('an unsupported mode cannot arm', v.error === 'incomplete_config');
v = validateOutreachConfigPatch({}, { enabled: false });
check('a disabled config stores without pretending values were chosen', !v.error && v.config.enabled === false);

console.log('\nHAPPY PATH RESERVES, SENDS, AND RECONCILES (SIMULATED)');
seed();
calls = [];
r = await runOutreach({ channel: 'postcard', selectCandidates: async () => [lead('a'), lead('b')], channelAdapter: stubAdapter({}, calls) });
check('both eligible leads send', r.ran === true && r.sent === 2 && calls.length === 2);
let effects = (await getRunEffects(r.run.id));
check('run counter consumed exactly two', effects.rc === 2);
const effA = effects.effects.find((e) => e.leadId === 'a');
check('effect is accepted with a provider reference', effA.status === STATUS.ACCEPTED && effA.providerRef === 'psc_a');
check('effect records one attempt', effA.attempts === 1);

calls = [];
const r2 = await runOutreach({ channel: 'postcard', selectCandidates: async () => [lead('a'), lead('b')], channelAdapter: stubAdapter({}, calls) });
check('a second run of the same day makes no new provider call', r2.sent === 0 && calls.length === 0);
effects = (await getRunEffects(r.run.id));
check('the cap reservation is not doubled', effects.rc === 2);

console.log('\nUNKNOWN OUTCOME KEEPS ITS RESERVATION AND RETRIES WITH THE SAME KEY (SIMULATED)');
seed();
calls = [];
const flaky = { c: [{ ok: false, unknown: true, retryable: true, reason: 'timeout' }, { ok: true, providerRef: 'psc_c' }] };
r = await runOutreach({ channel: 'postcard', selectCandidates: async () => [lead('c')], channelAdapter: stubAdapter(flaky, calls) });
check('timeout outcome leaves the effect unknown', r.sent === 0 && r.run.unknown === 1);
let effC = (await getRunEffects(r.run.id)).effects.find((e) => e.leadId === 'c');
check('unknown effect is durably unknown with one attempt', effC.status === STATUS.UNKNOWN && effC.attempts === 1);
const keyC = calls[0].idempotencyKey;

const r3 = await runOutreach({ channel: 'postcard', selectCandidates: async () => [lead('c')], channelAdapter: stubAdapter(flaky, calls) });
check('the retry sends and reconciles to accepted', r3.sent === 1);
check('the retry reused the SAME provider idempotency key', calls.length === 2 && calls[1].idempotencyKey === keyC);
effects = (await getRunEffects(r.run.id));
check('the retry consumed NO additional capacity', effects.rc === 1);
effC = effects.effects.find((e) => e.leadId === 'c');
check('the effect now carries the provider reference', effC.status === STATUS.ACCEPTED && effC.providerRef === 'psc_c' && effC.attempts === 2);

console.log('\nRETRY CEILING ENDS DEAD, NEVER RESURRECTED (SIMULATED)');
seed();
calls = [];
const alwaysFlaky = { d: [{ ok: false, unknown: true, retryable: true, reason: 'timeout' }] };
let firstFlakyRunId = null;
for (let i = 0; i < 4; i++) {
  r = await runOutreach({ channel: 'postcard', selectCandidates: async () => [lead('d')], channelAdapter: stubAdapter(alwaysFlaky, calls) });
  if (!firstFlakyRunId) firstFlakyRunId = r.run.id;
}
check('the adapter was attempted exactly the bounded ceiling', calls.length === 3);
check('every attempt used the same idempotency key', calls.every((c) => c.idempotencyKey === calls[0].idempotencyKey));
const effD = (await getRunEffects(firstFlakyRunId)).effects.find((e) => e.leadId === 'd');
check('the effect is dead with a terminal reason after the ceiling', effD.status === STATUS.DEAD && !!effD.terminalReason);
check('its capacity stays pessimistically reserved', (await getRunEffects(firstFlakyRunId)).rc === 1);

console.log('\nKNOWN PERMANENT FAILURE IS TERMINAL WITHOUT RETRY SPEND (SIMULATED)');
seed();
calls = [];
const badAddr = { e: [{ ok: false, retryable: false, reason: 'bad_address' }] };
r = await runOutreach({ channel: 'postcard', selectCandidates: async () => [lead('e')], channelAdapter: stubAdapter(badAddr, calls) });
check('a permanent rejection dead-letters on the first attempt', r.sent === 0 && r.run.dead === 1 && calls.length === 1);
r = await runOutreach({ channel: 'postcard', selectCandidates: async () => [lead('e')], channelAdapter: stubAdapter(badAddr, calls) });
check('a dead effect is never retried', calls.length === 1);

console.log('\nELIGIBILITY IS RE-DERIVED AT THE PROVIDER BOUNDARY (SIMULATED TOCTOU)');
seed();
calls = [];
r = await runOutreach({
  channel: 'postcard',
  selectCandidates: async () => [lead('f', { email: 'f@shop.test' })],
  beforeCandidate: async () => {
    // The prospect becomes a paying customer after selection, before the send.
    await upsertAccount({ email: 'f@shop.test', plan: ['P1'], stripeCustomerId: 'cus_f' });
  },
  channelAdapter: stubAdapter({}, calls),
});
check('a brand-new customer gets NO provider call', r.sent === 0 && calls.length === 0);

seed();
calls = [];
const flakyG = { g: [{ ok: false, unknown: true, retryable: true, reason: 'timeout' }] };
r = await runOutreach({ channel: 'postcard', selectCandidates: async () => [lead('g', { email: 'g@shop.test' })], channelAdapter: stubAdapter(flakyG, calls) });
check('first attempt ends unknown', r.run.unknown === 1 && calls.length === 1);
const gRunId = r.run.id;
await suppressContact({ email: 'g@shop.test' }, { reason: 'stop', actor: 'test' });
r = await runOutreach({ channel: 'postcard', selectCandidates: async () => [lead('g', { email: 'g@shop.test' })], channelAdapter: stubAdapter(flakyG, calls) });
check('a contact suppressed between attempts gets NO retry call', calls.length === 1);
const effG = (await getRunEffects(gRunId)).effects.find((e) => e.leadId === 'g');
check('the open effect closes with the exclusion as terminal reason', effG.status === STATUS.DEAD && effG.terminalReason === 'excluded_suppressed');

console.log('\nLEASE IS AN OWNED RUN, NOT A CORRECTNESS CRUTCH');
seed();
await acquireLease('squatter', 60000);
calls = [];
r = await runOutreach({ channel: 'postcard', selectCandidates: async () => [lead('h')], channelAdapter: stubAdapter({}, calls) });
check('an overlapping runner is refused with no provider call', r.ran === false && r.reason === 'lease_held' && calls.length === 0);
await releaseLease('squatter');

seed();
calls = [];
let stole = false;
r = await runOutreach({
  channel: 'postcard',
  selectCandidates: async () => [lead('i'), lead('j')],
  beforeCandidate: async (l) => {
    if (l.id === 'j' && !stole) {
      stole = true;
      KV.delete('ks:outreach:lease');
      await acquireLease('other-owner', 60000);
    }
  },
  channelAdapter: stubAdapter({}, calls),
});
check('a lost lease stops the run before new provider effects', r.run.stopReason === 'lease_lost' && calls.length === 1);
await releaseLease('other-owner');

console.log('\nPER-RUN CAP BOUNDS THE BATCH (SIMULATED)');
seed({ ...ARMED, perRunCap: 1 });
calls = [];
r = await runOutreach({ channel: 'postcard', selectCandidates: async () => [lead('k'), lead('l')], channelAdapter: stubAdapter({}, calls) });
check('exactly the cap sends', r.sent === 1 && calls.length === 1);
check('the run records the cap stop', r.run.capStop === 'per_run_cap');

console.log('\nUNPUBLISHED DRAFT AT RUN LEVEL: PLAIN-OFFER SEND, DRAFT UNTOUCHED (SIMULATED)');
seed();
await upsertSite({
  slug: 'shop-m', business: 'Shop m', city: 'Kansas City', state: 'MO',
  modules: ['P0'], claimed: false, published: false,
});
r = await runOutreach({ channel: 'postcard', selectCandidates: async () => [lead('m', { siteSlug: 'shop-m' })], channelAdapter: sendPostcard });
check('the run sends the plain offer for an unpublished destination', r.sent === 1 && lobCalls.length === 1);
check('the card is the offer variant with the /start QR', lobCalls[0].front.includes('Your business website.') && lobCalls[0].back.includes('qr-start.png'));
const effM = (await getRunEffects(r.run.id)).effects.find((e) => e.leadId === 'm');
check('the effect is accepted with a provider ref', effM.status === STATUS.ACCEPTED && !!effM.providerRef);
const siteM = await getSite('shop-m');
check('the draft stays unpublished, unclaimed, unmodified', siteM.published === false && siteM.claimed === false && JSON.stringify(siteM.modules) === JSON.stringify(['P0']));

console.log('\nPREFLIGHT FAILURE BURNS NO CAP AND NO EFFECT (SIMULATED)');
seed({ ...ARMED, perRunCap: 1 });
calls = [];
r = await runOutreach({
  channel: 'postcard',
  selectCandidates: async () => [lead('n')],
  preflightCandidate: async () => { throw new Error('store unavailable'); },
  channelAdapter: stubAdapter({}, calls),
});
check('a candidate that cannot be attempted is skipped with no provider call', r.sent === 0 && r.run.skipped === 1 && calls.length === 0);
const runN = await getRunEffects(r.run.id);
check('no effect reserved and no run/daily counter consumed', runN.effects.length === 0 && runN.rc === 0 && runN.dc === 0);

console.log('\nTRUE PER-RUN NAMESPACE: 1/RUN + 3/DAY SIMULATED POLICY TRACE');
const SMALL = {
  enabled: true, mode: 'test', channels: ['postcard'],
  perRunCap: 1, dailyCap: 3, lifetimeCap: 1, perRunSpendCap: 150, dailySpendCap: 450,
  postcardReserveCents: 110,
};
seed(SMALL);
calls = [];
const trace = (runId, leads) => runOutreach({ channel: 'postcard', runId, selectCandidates: async () => leads, channelAdapter: stubAdapter({}, calls) });

let rA = await trace('outreach-run-postcard-testA', [lead('ta'), lead('ta2')]);
check('run A: one send, per-run cap stops the second candidate in the SAME run', rA.sent === 1 && rA.run.capStop === 'per_run_cap' && calls.length === 1);
check('run A: the injected runId is the run identity', rA.run.id === 'outreach-run-postcard-testA');
let nsA = await getRunEffects('outreach-run-postcard-testA');
check('run A namespace: rc=1, rsc=110, while daily starts dc=1, dsc=110', nsA.rc === 1 && nsA.rsc === 110 && nsA.dc === 1 && nsA.dsc === 110);

let rB = await trace('outreach-run-postcard-testB', [lead('tb')]);
check('run B same day: fresh per-run namespace sends one more', rB.sent === 1 && calls.length === 2);
let nsB = await getRunEffects('outreach-run-postcard-testB');
check('run B namespace: rc=1 while the shared daily counters rise to dc=2, dsc=220', nsB.rc === 1 && nsB.dc === 2 && nsB.dsc === 220);

let rC = await trace('outreach-run-postcard-testC', [lead('tc')]);
check('run C: third business sends, daily total 3', rC.sent === 1 && calls.length === 3);
check('daily reserved spend is 330 after three runs', (await getRunEffects('outreach-run-postcard-testC')).dsc === 330);

let rD = await trace('outreach-run-postcard-testD', [lead('td')]);
check('run D: DAILY_CAP_REACHED, zero provider call, zero reservation', rD.sent === 0 && rD.run.capStop === 'DAILY_CAP_REACHED' && calls.length === 3);
check('exactly three accepted effects exist after four runs', (await getStatusCounts()).accepted === 3);
check('run D namespace stayed empty', (await getRunEffects('outreach-run-postcard-testD')).rc === 0);

let rE = await trace('outreach-run-postcard-testE', [lead('ta')]);
check('run E: an already-accepted business in a fresh runId sends nothing', rE.sent === 0 && rE.run.skipped === 1 && calls.length === 3);
check('no second effect and no new reservation for the repeat business', (await getStatusCounts()).accepted === 3 && (await getRunEffects('outreach-run-postcard-testE')).rc === 0);

console.log('\nDEFAULT RUN IDS ARE UNIQUE PER INVOCATION');
seed({ ...ARMED, perRunCap: 1 });
calls = [];
let u1 = await runOutreach({ channel: 'postcard', selectCandidates: async () => [lead('u1')], channelAdapter: stubAdapter({}, calls) });
let u2 = await runOutreach({ channel: 'postcard', selectCandidates: async () => [lead('u2')], channelAdapter: stubAdapter({}, calls) });
check('two default runs get different runIds', u1.run.id !== u2.run.id);
check('a second invocation the same day is no longer run-capped', u1.sent === 1 && u2.sent === 1 && calls.length === 2);

console.log('\nCONCURRENT RUNS RACE THE LAST DAILY SLOT (SIMULATED)');
seed(SMALL);
await acquireLease('race-owner', 60000);
const raceEffect = (runId, id) => ({
  runId, channel: 'postcard', provider: 'lob', canonicalId: id, leadId: id,
  idempotencyKey: 'k-' + id, eligibility: { eligible: true, canonicalId: id },
  createdAt: new Date().toISOString(),
});
await reserveEffect({ owner: 'race-owner', effect: raceEffect('race-r1', 'rb1'), cfg: SMALL, costCents: 110 });
await reserveEffect({ owner: 'race-owner', effect: raceEffect('race-r2', 'rb2'), cfg: SMALL, costCents: 110 });
const [w1, w2] = await Promise.all([
  reserveEffect({ owner: 'race-owner', effect: raceEffect('race-r3', 'rb3'), cfg: SMALL, costCents: 110 }),
  reserveEffect({ owner: 'race-owner', effect: raceEffect('race-r4', 'rb4'), cfg: SMALL, costCents: 110 }),
]);
const winners = [w1, w2].filter((w) => w.ok && !w.exists);
const losers = [w1, w2].filter((w) => !w.ok);
check('exactly one racer reserves the last daily slot', winners.length === 1 && losers.length === 1 && losers[0].status === 'DAILY_CAP_REACHED');
check('daily counters stop exactly at the cap', (await getRunEffects('race-r3')).dc === 3 && (await getRunEffects('race-r3')).dsc === 330);
await releaseLease('race-owner');

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
clearKvStub();
process.exit(fail ? 1 : 0);
