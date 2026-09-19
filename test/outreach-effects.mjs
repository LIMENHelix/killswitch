// K6 pre-outreach safety tests for the durable outbound-effect ledger.
//
// These tests exercise lib/outreach-effects.js with an in-memory KV stub so no
// real Redis, mail provider, or outbound send is involved.

process.env.KV_REST_API_URL = 'https://kv.outreach.test';
process.env.KV_REST_API_TOKEN = 'token';
delete process.env.VERCEL_ENV;

import { setupKvStub, clearKvStub } from './helpers/k6-kv.mjs';

const { KV } = setupKvStub();

const {
  STATUS,
  makeEffectId,
  makeIdempotencyKey,
  acquireLease,
  renewLease,
  checkLease,
  releaseLease,
  reserveEffect,
  getEffect,
  updateEffect,
  recordRun,
  getRun,
  getRunEffects,
  getStatusCounts,
  listEffects,
} = await import('../lib/outreach-effects.js');

let pass = 0, fail = 0;
const check = (name, condition, detail = '') => {
  if (condition) { console.log('  PASS  ' + name); pass++; }
  else { console.log('  FAIL  ' + name + (detail ? '  <- ' + detail : '')); fail++; }
};

const seed = () => { KV.clear(); };
const baseEffect = (overrides = {}) => ({
  runId: 'run-20260101-postcard',
  channel: 'postcard',
  provider: 'lob',
  canonicalId: 'lead-1',
  leadId: 'lead-1',
  idempotencyKey: 'key-1',
  eligibility: { eligible: true, canonicalId: 'lead-1' },
  createdAt: new Date().toISOString(),
  ...overrides,
});
const baseCfg = () => ({
  perRunCap: 3,
  dailyCap: 5,
  lifetimeCap: 10,
  perRunSpendCap: 1000,
  dailySpendCap: 2000,
});

console.log('\nEFFECT IDENTITY IS STABLE AND DERIVED FROM CHANNEL + BUSINESS, NOT RUN');
const e1 = baseEffect();
const idA = makeEffectId(e1);
const idB = makeEffectId({ ...e1, channel: 'postcard' });
const idC = makeEffectId({ ...e1, channel: 'email' });
check('same channel/canonicalId produces the same effect id', idA === idB);
check('a different runId produces the SAME effect id (run is not identity)', makeEffectId({ ...e1, runId: 'outreach-run-postcard-other' }) === idA);
check('different channel produces a different effect id', idC !== idA);
check('effect id has the expected oe- prefix and length', /^oe-[a-f0-9]{32}$/.test(idA));
check('idempotency key includes the effect id and attempt', makeIdempotencyKey({ effectId: idA, attempt: 2 }) === `${idA}:2`);

console.log('\nLEASE IS EXCLUSIVE AND SELF-RELEASING');
seed();
const ownerA = 'own-a';
const ownerB = 'own-b';
check('first owner acquires the lease', await acquireLease(ownerA, 60000));
check('second owner cannot steal the lease', !(await acquireLease(ownerB, 60000)));
check('current owner passes the lease check', await checkLease(ownerA));
check('non-owner fails the lease check', !(await checkLease(ownerB)));
check('owner can renew the lease', await renewLease(ownerA, 60000));
check('non-owner cannot renew the lease', !(await renewLease(ownerB, 60000)));
check('owner can release the lease', await releaseLease(ownerA));
check('released lease is gone', !(await checkLease(ownerA)));
check('a new owner can acquire after release', await acquireLease(ownerB, 60000));
await releaseLease(ownerB);

console.log('\nRESERVE ATOMICALLY WRITES EFFECT AND INCREMENTS COUNTERS');
seed();
const owner1 = 'own-1';
await acquireLease(owner1, 60000);
const eff1 = baseEffect();
const r1 = await reserveEffect({ owner: owner1, effect: eff1, cfg: baseCfg() });
check('reserve returns OK for a fresh effect', r1.ok && r1.status === 'OK' && r1.effectId === makeEffectId(eff1));
check('effect is persisted with RESERVED status', (await getEffect(r1.effectId))?.status === STATUS.RESERVED);
const runEff1 = await getRunEffects(eff1.runId);
check('run counter is incremented to 1', runEff1.rc === 1);
check('daily counter is incremented to 1', runEff1.dc === 1);
check('returned run effects include the new effect', runEff1.effects.some((e) => e.effectId === r1.effectId));
await releaseLease(owner1);

console.log('\nCAPS ARE ENFORCED WITHOUT DOUBLE-SPENDING');
seed();
const owner2 = 'own-2';
await acquireLease(owner2, 60000);
const cfgLow = { perRunCap: 2, dailyCap: 2, lifetimeCap: 2, perRunSpendCap: 1000, dailySpendCap: 1000 };
const ids = [];
for (let i = 0; i < 3; i++) {
  const res = await reserveEffect({ owner: owner2, effect: baseEffect({ canonicalId: `lead-${i}`, leadId: `lead-${i}` }), cfg: cfgLow });
  ids.push(res);
}
check('first two reservations succeed', ids[0].ok && ids[1].ok);
check('third reservation hits per-run cap', !ids[2].ok && ids[2].status === 'RUN_CAP_REACHED');
check('only two effects are stored', Object.keys(KV.get('ks:outreach:effects') || {}).length === 2);
check('run counter equals the cap', (await getRunEffects(ids[0].effect.runId)).rc === 2);
await releaseLease(owner2);

console.log('\nSPEND CAPS ARE ENFORCED');
seed();
const owner3 = 'own-3';
await acquireLease(owner3, 60000);
const cfgSpend = { perRunCap: 10, dailyCap: 10, lifetimeCap: 10, perRunSpendCap: 100, dailySpendCap: 100 };
const s1 = await reserveEffect({ owner: owner3, effect: baseEffect({ canonicalId: 'spend-1', leadId: 'spend-1' }), cfg: cfgSpend, costCents: 60 });
const s2 = await reserveEffect({ owner: owner3, effect: baseEffect({ canonicalId: 'spend-2', leadId: 'spend-2' }), cfg: cfgSpend, costCents: 60 });
check('first spend reservation fits within the cap', s1.ok);
check('second spend reservation exceeds per-run spend cap', !s2.ok && s2.status === 'RUN_SPEND_CAP_REACHED');
const runEff3 = await getRunEffects(s1.effect.runId);
check('run spend counter reflects only the accepted cost', runEff3.rsc === 60);
check('daily spend counter reflects only the accepted cost', runEff3.dsc === 60);
await releaseLease(owner3);

console.log('\nLIFETIME AND DAILY CAPS ARE INDEPENDENT');
seed();
const owner4 = 'own-4';
await acquireLease(owner4, 60000);
const cfgLife = { perRunCap: 100, dailyCap: 1, lifetimeCap: 100, perRunSpendCap: 100000, dailySpendCap: 100000 };
const d1 = await reserveEffect({ owner: owner4, effect: baseEffect({ canonicalId: 'daily-1', leadId: 'daily-1' }), cfg: cfgLife });
const d2 = await reserveEffect({ owner: owner4, effect: baseEffect({ canonicalId: 'daily-2', leadId: 'daily-2' }), cfg: cfgLife });
check('first reservation consumes the daily cap', d1.ok);
check('second reservation hits the daily cap', !d2.ok && d2.status === 'DAILY_CAP_REACHED');
const cfgLifeOnly = { perRunCap: 100, dailyCap: 100, lifetimeCap: 1, perRunSpendCap: 100000, dailySpendCap: 100000 };
const l1 = await reserveEffect({ owner: owner4, effect: baseEffect({ runId: 'run-life-a', canonicalId: 'life-biz', leadId: 'life-biz' }), cfg: cfgLifeOnly });
const dcBeforeReplay = (await getRunEffects('run-life-a')).dc;
const l2 = await reserveEffect({ owner: owner4, effect: baseEffect({ runId: 'run-life-b', canonicalId: 'life-biz', leadId: 'life-biz' }), cfg: cfgLifeOnly });
check('first contact with a business consumes its lifetime cap', l1.ok && l1.status === 'OK');
check('a second logical effect for the SAME business returns EXISTS, never a duplicate', l2.ok && l2.exists === true);
check('the EXISTS replay consumed no daily counter', (await getRunEffects('run-life-b')).dc === dcBeforeReplay);
// Legacy backstop: an effect reserved before identity-scoped ids (its stored
// effectId embeds an old run id) does not EXISTS-match a fresh reservation,
// so the lifetime counter is what blocks re-contact for those businesses.
KV.set('ks:outreach:lc:legacy-biz', '1');
const l3 = await reserveEffect({ owner: owner4, effect: baseEffect({ runId: 'run-life-c', canonicalId: 'legacy-biz', leadId: 'legacy-biz' }), cfg: cfgLifeOnly });
check('a business whose lifetime counter is already consumed is blocked', !l3.ok && l3.status === 'LIFETIME_CAP_REACHED');
check('no new effect was created for the lifetime-blocked business', !(await getEffect(makeEffectId({ channel: 'postcard', canonicalId: 'legacy-biz' }))));
await releaseLease(owner4);

console.log('\nIDEMPOTENCY RETURNS EXISTING EFFECT WITHOUT DOUBLE-COUNTING');
seed();
const owner5 = 'own-5';
await acquireLease(owner5, 60000);
const effDup = baseEffect({ canonicalId: 'dup-1', leadId: 'dup-1' });
const dup1 = await reserveEffect({ owner: owner5, effect: effDup, cfg: baseCfg() });
const dup2 = await reserveEffect({ owner: owner5, effect: { ...effDup, status: STATUS.ATTEMPTING }, cfg: baseCfg() });
check('first reservation succeeds', dup1.ok && !dup1.exists);
check('duplicate reservation reports EXISTS', dup2.ok && dup2.exists);
check('counter is not incremented for the duplicate', (await getRunEffects(effDup.runId)).rc === 1);
await releaseLease(owner5);

console.log('\nINVALID CAPS ARE REJECTED');
seed();
const owner6 = 'own-6';
await acquireLease(owner6, 60000);
const badCfg = { perRunCap: 0, dailyCap: 1, lifetimeCap: 1, perRunSpendCap: 1, dailySpendCap: 1 };
const bad = await reserveEffect({ owner: owner6, effect: baseEffect(), cfg: badCfg });
check('zero cap is rejected as invalid', !bad.ok && bad.status === 'INVALID_CAP');
await releaseLease(owner6);

console.log('\nUPDATE AND RUN RECORDING REQUIRE THE LEASE');
seed();
const owner7 = 'own-7';
await acquireLease(owner7, 60000);
const effUp = baseEffect({ canonicalId: 'upd-1', leadId: 'upd-1' });
const resUp = await reserveEffect({ owner: owner7, effect: effUp, cfg: baseCfg() });
const up1 = await updateEffect({ owner: owner7, effectId: resUp.effectId, patch: { status: STATUS.ACCEPTED, providerRef: 'ref-123' } });
check('update with valid lease succeeds', up1.ok && up1.effect.status === STATUS.ACCEPTED && up1.effect.providerRef === 'ref-123');
check('effect reflects the update', (await getEffect(resUp.effectId)).providerRef === 'ref-123');
const up2 = await updateEffect({ owner: 'other-owner', effectId: resUp.effectId, patch: { status: STATUS.DEAD } });
check('update with wrong lease is rejected', !up2.ok && up2.status === 'LEASE_LOST');
const runId7 = effUp.runId;
const rec1 = await recordRun({ owner: owner7, runId: runId7, run: { id: runId7, status: 'completed', sent: 1 } });
check('run record with valid lease succeeds', rec1);
check('run record can be read back', (await getRun(runId7))?.status === 'completed');
const rec2 = await recordRun({ owner: 'other-owner', runId: runId7, run: { id: runId7, status: 'failed' } });
check('run record with wrong lease is rejected', !rec2);
await releaseLease(owner7);

console.log('\nSTATUS AGGREGATION AND LISTING');
seed();
const owner8 = 'own-8';
await acquireLease(owner8, 60000);
const effs = [
  baseEffect({ canonicalId: 'stat-1', leadId: 'stat-1', runId: 'run-stats' }),
  baseEffect({ canonicalId: 'stat-2', leadId: 'stat-2', runId: 'run-stats' }),
  baseEffect({ canonicalId: 'stat-3', leadId: 'stat-3', runId: 'run-stats' }),
];
for (const e of effs) await reserveEffect({ owner: owner8, effect: e, cfg: baseCfg() });
await updateEffect({ owner: owner8, effectId: makeEffectId(effs[0]), patch: { status: STATUS.ACCEPTED } });
await updateEffect({ owner: owner8, effectId: makeEffectId(effs[1]), patch: { status: STATUS.DEAD } });
const counts = await getStatusCounts();
check('status counts sum to the number of stored effects', (counts[STATUS.RESERVED] || 0) + (counts[STATUS.ACCEPTED] || 0) + (counts[STATUS.DEAD] || 0) === 3);
check('accepted effect is counted', counts[STATUS.ACCEPTED] === 1);
check('dead effect is counted', counts[STATUS.DEAD] === 1);
const listed = await listEffects(10);
check('listEffects returns the stored effects', listed.length === 3);
const runStats = await getRunEffects('run-stats');
check('getRunEffects filters by run id', runStats.effects.length === 3);
await releaseLease(owner8);

console.log('\nCORRUPT COUNTERS ARE DETECTED');
seed();
const owner9 = 'own-9';
await acquireLease(owner9, 60000);
KV.set('ks:outreach:rc:run-corrupt', 'not-a-number');
const corrupt = await reserveEffect({ owner: owner9, effect: baseEffect({ runId: 'run-corrupt' }), cfg: baseCfg() });
check('corrupt run counter returns a diagnostic status', !corrupt.ok && corrupt.status === 'CORRUPT_COUNTER');
KV.set('ks:outreach:rsc:run-corrupt-spend', '1.5');
const corruptSpend = await reserveEffect({ owner: owner9, effect: baseEffect({ runId: 'run-corrupt-spend' }), cfg: baseCfg() });
check('corrupt spend counter fails closed', !corruptSpend.ok && corruptSpend.status === 'CORRUPT_COUNTER');
await releaseLease(owner9);

console.log('\nTERMINAL STATES CANNOT BE RESURRECTED');
seed();
const owner10 = 'own-10';
await acquireLease(owner10, 60000);
const effTerm = baseEffect({ canonicalId: 'term-1', leadId: 'term-1' });
const resTerm = await reserveEffect({ owner: owner10, effect: effTerm, cfg: baseCfg() });
const acc = await updateEffect({ owner: owner10, effectId: resTerm.effectId, patch: { status: STATUS.ACCEPTED, providerRef: 'psc_1' } });
check('effect can reach accepted', acc.ok);
const revive = await updateEffect({ owner: owner10, effectId: resTerm.effectId, patch: { status: STATUS.ATTEMPTING } });
check('accepted -> attempting is refused as TERMINAL_LOCKED', !revive.ok && revive.status === 'TERMINAL_LOCKED');
check('stored record is still accepted', (await getEffect(resTerm.effectId)).status === STATUS.ACCEPTED);
const sameTerm = await updateEffect({ owner: owner10, effectId: resTerm.effectId, patch: { status: STATUS.ACCEPTED, providerRef: 'psc_1' } });
check('even a same-status rewrite of a terminal effect is locked', !sameTerm.ok && sameTerm.status === 'TERMINAL_LOCKED');
const deadPath = await updateEffect({ owner: owner10, effectId: resTerm.effectId, patch: { status: STATUS.DEAD, terminalReason: 'x' } });
check('accepted -> dead is also refused', !deadPath.ok && deadPath.status === 'TERMINAL_LOCKED');
await releaseLease(owner10);

console.log('\nTERMINAL LOCK READS ONLY THE AUTHORITATIVE TOP-LEVEL STATUS');
// The embedded lead snapshot may carry its own status field. The lock must
// look ONLY at the effect's top-level status, never at lead data.
seed();
const owner11 = 'own-11';
await acquireLease(owner11, 60000);
const leadStatusCases = [
  { leadStatus: 'ready', top: STATUS.ACCEPTED, attempt: STATUS.ATTEMPTING },
  { leadStatus: 'retryable', top: STATUS.ACCEPTED, attempt: STATUS.ATTEMPTING },
  { leadStatus: 'unknown', top: STATUS.DEAD, attempt: STATUS.RETRYABLE },
  { leadStatus: 'accepted', top: STATUS.REJECTED, attempt: STATUS.UNKNOWN },
];
for (let i = 0; i < leadStatusCases.length; i++) {
  const c = leadStatusCases[i];
  const eff = baseEffect({
    canonicalId: 'leadstat-' + i, leadId: 'leadstat-' + i,
    lead: { id: 'leadstat-' + i, name: 'Shop ' + i, status: c.leadStatus },
  });
  const res = await reserveEffect({ owner: owner11, effect: eff, cfg: { ...baseCfg(), perRunCap: 100 } });
  const term = await updateEffect({ owner: owner11, effectId: res.effectId, patch: { status: c.top, terminalReason: 't' } });
  check(`lead.status=${c.leadStatus}: effect reaches ${c.top}`, term.ok);
  const blocked = await updateEffect({ owner: owner11, effectId: res.effectId, patch: { status: c.attempt } });
  check(`lead.status=${c.leadStatus}: ${c.top} -> ${c.attempt} is BLOCKED`, !blocked.ok && blocked.status === 'TERMINAL_LOCKED');
  const stored = await getEffect(res.effectId);
  check(`lead.status=${c.leadStatus}: stored effect remains ${c.top}`, stored.status === c.top && stored.lead.status === c.leadStatus);
}

console.log('\nCORRUPT EFFECT RECORDS FAIL CLOSED WITH ZERO MUTATION');
const owner12 = owner11;
const malformedId = 'oe-malformed';
const effectsHash = KV.get('ks:outreach:effects') || {};
effectsHash[malformedId] = '{not json';
KV.set('ks:outreach:effects', effectsHash);
const bad1 = await updateEffect({ owner: owner12, effectId: malformedId, patch: { status: STATUS.ATTEMPTING } });
check('malformed stored JSON fails closed', !bad1.ok);
check('malformed record is untouched', (KV.get('ks:outreach:effects') || {})[malformedId] === '{not json');

const noStatusId = 'oe-nostatus';
effectsHash[noStatusId] = JSON.stringify({ effectId: noStatusId, runId: 'r', channel: 'postcard' });
KV.set('ks:outreach:effects', effectsHash);
const bad2 = await updateEffect({ owner: owner12, effectId: noStatusId, patch: { status: STATUS.ATTEMPTING } });
check('missing top-level status fails closed', !bad2.ok && bad2.status === 'CORRUPT_EFFECT');
check('status-less record is untouched', !JSON.parse((KV.get('ks:outreach:effects') || {})[noStatusId]).status);

const numStatusId = 'oe-numstatus';
effectsHash[numStatusId] = JSON.stringify({ effectId: numStatusId, status: 5 });
KV.set('ks:outreach:effects', effectsHash);
const bad3 = await updateEffect({ owner: owner12, effectId: numStatusId, patch: { status: STATUS.ATTEMPTING } });
check('non-string top-level status fails closed', !bad3.ok && bad3.status === 'CORRUPT_EFFECT');

const bogusStatusId = 'oe-bogusstatus';
effectsHash[bogusStatusId] = JSON.stringify({ effectId: bogusStatusId, status: 'bogus' });
KV.set('ks:outreach:effects', effectsHash);
const bad4 = await updateEffect({ owner: owner12, effectId: bogusStatusId, patch: { status: STATUS.ATTEMPTING } });
check('unrecognized top-level status fails closed', !bad4.ok && bad4.status === 'CORRUPT_EFFECT');

console.log('\nLEGITIMATE NONTERMINAL TRANSITIONS STILL WORK');
const effFlow = baseEffect({ canonicalId: 'flow-1', leadId: 'flow-1', lead: { id: 'flow-1', status: 'ready' } });
const resFlow = await reserveEffect({ owner: owner12, effect: effFlow, cfg: { ...baseCfg(), perRunCap: 100 } });
const f1 = await updateEffect({ owner: owner12, effectId: resFlow.effectId, patch: { status: STATUS.ATTEMPTING } });
check('reserved -> attempting works', f1.ok);
const f2 = await updateEffect({ owner: owner12, effectId: resFlow.effectId, patch: { status: STATUS.UNKNOWN, attempts: 1 } });
check('attempting -> unknown works', f2.ok);
const f3 = await updateEffect({ owner: owner12, effectId: resFlow.effectId, patch: { status: STATUS.ATTEMPTING } });
check('unknown -> attempting (retry) works', f3.ok);
const f4 = await updateEffect({ owner: owner12, effectId: resFlow.effectId, patch: { status: STATUS.ACCEPTED, providerRef: 'psc_ok' } });
check('attempting -> accepted works', f4.ok);
const f5 = await updateEffect({ owner: owner12, effectId: resFlow.effectId, patch: { status: STATUS.ATTEMPTING } });
check('accepted is then locked', !f5.ok && f5.status === 'TERMINAL_LOCKED');

console.log('\nHISTORICAL RUN-SCOPED EFFECT IDS STAY TERMINAL-LOCKED');
// Effects written before identity-scoped ids keep their old id shape; the
// terminal lock applies to them unchanged.
const legacyId = 'oe-' + '0'.repeat(31) + '1';
const legacyHash = KV.get('ks:outreach:effects') || {};
legacyHash[legacyId] = JSON.stringify({ effectId: legacyId, runId: 'outreach-run-postcard-20260918', channel: 'postcard', status: 'accepted', attempts: 1 });
KV.set('ks:outreach:effects', legacyHash);
const legacyRevive = await updateEffect({ owner: owner12, effectId: legacyId, patch: { status: STATUS.ATTEMPTING } });
check('a historical terminal effect cannot be resurrected', !legacyRevive.ok && legacyRevive.status === 'TERMINAL_LOCKED');
check('the historical record is untouched', JSON.parse((KV.get('ks:outreach:effects') || {})[legacyId]).status === 'accepted');

await releaseLease(owner12);

console.log('\nA STALE OWNER CANNOT RELEASE A SUCCESSOR LEASE');
seed();
const staleA = 'own-stale-a';
const liveB = 'own-live-b';
check('owner A acquires', await acquireLease(staleA, 60000));
KV.delete('ks:outreach:lease'); // simulate A's lease expiring (TTL) before A finishes
check('owner B acquires after expiry', await acquireLease(liveB, 60000));
check('stale A cannot release B\'s lease', !(await releaseLease(staleA)));
check('B still holds the lease', await checkLease(liveB));
check('B releases its own lease', await releaseLease(liveB));

clearKvStub();

console.log(fail ? `\n${pass} passed, ${fail} FAILED` : `\n${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
