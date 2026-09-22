// K4/K5 AUTONOMOUS REPLENISHMENT — discovery → dedupe → ranking → factual
// unpublished draft → outreach-ready inventory, proven end-to-end across
// MULTIPLE cron invocations. SIMULATED throughout: Places fetch is stubbed,
// KV is an in-memory Map behind the REST shape, and the EVAL mock
// re-implements the Lua invariants (markers: disc_* / draft_*). Real
// atomicity on the live path is derived from Upstash single-script
// execution, not exercised here.
import path from 'node:path';
const ROOT = path.join(import.meta.dirname, '..');
process.env.KV_REST_API_URL = 'https://kv.test/';
process.env.KV_REST_API_TOKEN = 'kvtok';
process.env.GOOGLE_PLACES_API_KEY = 'places_stub';
process.env.CRON_SECRET = 'cronsecret';
process.env.ADMIN_KEY = 'admintok';

const KV = new Map();
const EXP = new Map();
const live = (key) => { if (EXP.has(key) && EXP.get(key) <= Date.now()) { KV.delete(key); EXP.delete(key); } };

const evalScript = (a) => {
  const script = a[1];
  const n = Number(a[2]);
  const keys = a.slice(3, 3 + n);
  const argv = a.slice(3 + n);
  if (script.includes('disc_reserve_v1')) {
    const [callId, dailyCap, runCap, record] = argv;
    const ledger = KV.get(keys[2]) || {};
    if (ledger[callId] !== undefined) return 'ALREADY_RESERVED';
    function checkCounter(key) {
      const raw = KV.get(key);
      if (raw == null) return 0;
      const num = Number(raw);
      if (!Number.isFinite(num) || num !== Math.floor(num) || num < 0) return 'CORRUPT';
      return num;
    }
    const d = checkCounter(keys[0]); if (d === 'CORRUPT') return 'CORRUPT_COUNTER';
    const r = checkCounter(keys[1]); if (r === 'CORRUPT') return 'CORRUPT_COUNTER';
    const dc = Number(dailyCap); if (!Number.isFinite(dc) || dc !== Math.floor(dc) || dc <= 0) return 'INVALID_CAP';
    const rc = Number(runCap); if (!Number.isFinite(rc) || rc !== Math.floor(rc) || rc <= 0) return 'INVALID_CAP';
    if (d >= dc) return 'DAILY_CAP';
    if (r >= rc) return 'RUN_CAP';
    KV.set(keys[0], String(d + 1));
    KV.set(keys[1], String(r + 1));
    ledger[callId] = record;
    KV.set(keys[2], ledger);
    return 'RESERVED';
  }
  if (script.includes('disc_lease_renew_v1') || script.includes('draft_lease_renew_v1')) {
    if (KV.get(keys[0]) === argv[0]) { EXP.set(keys[0], Date.now() + Number(argv[1])); return 'OK'; }
    return 'LOST';
  }
  if (script.includes('disc_lease_release_v1') || script.includes('draft_lease_release_v1')) {
    if (KV.get(keys[0]) === argv[0]) { KV.delete(keys[0]); EXP.delete(keys[0]); return 1; }
    return 0;
  }
  if (script.includes('disc_complete_v1')) {
    const [owner, runId, runJson, cursorJson] = argv;
    if (KV.get(keys[0]) !== owner) return 'LEASE_LOST';
    const h = KV.get(keys[1]) || {}; h[runId] = runJson; KV.set(keys[1], h);
    KV.set(keys[2], cursorJson);
    return 'COMPLETED';
  }
  if (script.includes('draft_complete_v1')) {
    const [owner, runId, runJson] = argv;
    if (KV.get(keys[0]) !== owner) return 'LEASE_LOST';
    const h = KV.get(keys[1]) || {}; h[runId] = runJson; KV.set(keys[1], h);
    return 'COMPLETED';
  }
  if (script.includes('draft_apply_v1')) {
    if (KV.get(keys[0]) !== argv[0]) return 'LEASE_LOST';
    const dp = Number(argv[8]);
    if (!Number.isFinite(dp) || dp !== Math.floor(dp) || dp <= 0) return 'INVALID_CAP';
    const rcRaw = KV.get(keys[6]);
    let rc = 0;
    if (rcRaw !== undefined) {
      rc = Number(rcRaw);
      if (!Number.isFinite(rc) || rc !== Math.floor(rc) || rc < 0) return 'CORRUPT_COUNTER';
    }
    const placeIdx = KV.get(keys[3]) || {};
    const existingSlug = placeIdx[argv[1]];
    if (existingSlug) {
      if (argv[6] === 'new') return ['EXISTING', existingSlug, 'new'];
    } else {
      if (KV.get(keys[1]) !== undefined) return ['COLLISION', argv[2]];
      const idx = KV.get(keys[2]) || {};
      if (idx[argv[2]] !== undefined) return ['COLLISION', argv[2]];
    }
    if (argv[6] === 'new') {
      if (rc >= dp) return 'CAP_REACHED';
      KV.set(keys[6], String(rc + 1));
      const effects = KV.get(keys[5]) || {};
      effects[argv[1]] = 'new';
      KV.set(keys[5], effects);
    } else if (argv[6] === 'repair' && existingSlug === argv[2]) {
      const effects = KV.get(keys[5]) || {};
      if (effects[argv[1]] === undefined) { effects[argv[1]] = 'repair'; KV.set(keys[5], effects); }
    }
    KV.set(keys[1], argv[3]);
    const idx = KV.get(keys[2]) || {}; idx[argv[2]] = argv[4]; KV.set(keys[2], idx);
    placeIdx[argv[1]] = argv[2]; KV.set(keys[3], placeIdx);
    const cands = KV.get(keys[4]) || {}; cands[argv[1]] = argv[5]; KV.set(keys[4], cands);
    return ['OK', argv[2], argv[6]];
  }
  if (script.includes('draft_link_v1')) {
    if (KV.get(keys[0]) !== argv[0]) return 'LEASE_LOST';
    const placeIdx = KV.get(keys[1]) || {};
    const existing = placeIdx[argv[1]];
    if (existing !== undefined && existing !== argv[2]) return ['MAPPING_CONFLICT', existing];
    placeIdx[argv[1]] = argv[2]; KV.set(keys[1], placeIdx);
    const cands = KV.get(keys[2]) || {}; cands[argv[1]] = argv[3]; KV.set(keys[2], cands);
    return 'OK';
  }
  if (script.includes('draft_candidate_update_v1')) {
    if (KV.get(keys[0]) !== argv[0]) return 'LEASE_LOST';
    const cands = KV.get(keys[1]) || {}; cands[argv[1]] = argv[2]; KV.set(keys[1], cands);
    return 'OK';
  }
  if (script.includes('draft_repair_index_v1')) {
    if (KV.get(keys[0]) !== argv[0]) return 'LEASE_LOST';
    const idx = KV.get(keys[1]) || {}; idx[argv[1]] = argv[2]; KV.set(keys[1], idx);
    return 'OK';
  }
  if (script.includes('draft_run_status_v1')) {
    if (KV.get(keys[0]) !== argv[0]) return 'LEASE_LOST';
    const runs = KV.get(keys[1]) || {}; runs[argv[1]] = argv[2]; KV.set(keys[1], runs);
    return 'OK';
  }
  throw new Error('unexpected eval script');
};

// ---- simulated Google Places ----
let placesCalls = 0;
let placesQueue = [];   // response bodies consumed in order; last one repeats
let placesFail = null;  // null | {status} | 'malformed'

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://kv.test')) {
    const args = JSON.parse(opts.body);
    const run = (a) => {
      const [cmd, key, f, v] = a;
      live(key);
      if (cmd === 'EVAL') return evalScript(a);
      if (cmd === 'GET') return KV.has(key) ? KV.get(key) : null;
      if (cmd === 'SET' && a[3] === 'NX') { if (KV.has(key)) return null; const px = a.indexOf('PX', 3), ex = a.indexOf('EX', 3); const ti = px > -1 ? px : ex; if (ti > -1) EXP.set(key, Date.now() + (a[ti] === 'PX' ? Number(a[ti + 1]) : Number(a[ti + 1]) * 1000)); KV.set(key, f); return 'OK'; }
      if (cmd === 'SET') {
        const px = a.indexOf('PX', 3), ex = a.indexOf('EX', 3);
        const ti = px > -1 ? px : ex;
        if (ti > -1) EXP.set(key, Date.now() + (a[ti] === 'PX' ? Number(a[ti + 1]) : Number(a[ti + 1]) * 1000));
        else EXP.delete(key);
        KV.set(key, f);
        return 'OK';
      }
      if (cmd === 'HSET') { const h = KV.get(key) || {}; h[f] = v; KV.set(key, h); return 1; }
      if (cmd === 'HGET') { const h = KV.get(key) || {}; return h[f] == null ? null : h[f]; }
      if (cmd === 'HGETALL') { const h = KV.get(key) || {}; const flat = []; for (const [k, val] of Object.entries(h)) flat.push(k, val); return flat; }
      if (cmd === 'HDEL') { const h = KV.get(key) || {}; delete h[f]; KV.set(key, h); return 1; }
      if (cmd === 'DEL') { KV.delete(key); return 1; }
      throw new Error('unexpected kv cmd ' + cmd);
    };
    if (u.endsWith('/pipeline')) return { ok: true, status: 200, json: async () => args.map((a) => ({ result: run(a) })) };
    return { ok: true, status: 200, json: async () => ({ result: run(args) }) };
  }
  if (u.startsWith('https://places.googleapis.com/')) {
    placesCalls++;
    if (placesFail === 'malformed') return { ok: true, status: 200, json: async () => ({ nope: true }) };
    if (placesFail && placesFail.status) return { ok: false, status: placesFail.status, text: async () => 'upstream broken' };
    const body = placesQueue.length > 1 ? placesQueue.shift() : placesQueue[0];
    return { ok: true, status: 200, json: async () => body };
  }
  throw new Error('unexpected fetch ' + u);
};

const { cmd, parseHash } = await import('../lib/kv.js');
const disc = await import('../lib/discovery.js');
const draftAuto = await import('../lib/draft-autonomy.js');
const { suppressContact } = await import('../lib/suppression.js');
const { postcardCandidatePool } = await import('../lib/k6-outreach.js');
const cronDiscovery = (await import('../api/cron-discovery.js')).default;
const cronDraft = (await import('../api/cron-draft.js')).default;

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };
const seed = () => {
  KV.clear(); EXP.clear();
  placesQueue = []; placesFail = null; placesCalls = 0;
  delete process.env.VERCEL_ENV;
  process.env.CRON_SECRET = 'cronsecret';
};
const mkRes = () => { const res = { code: 0, body: null }; res.status = (c) => { res.code = c; return res; }; res.json = (o) => { res.body = o; return res; }; return res; };
const callCron = async (handler, auth) => {
  const res = mkRes();
  await handler({ method: 'GET', headers: auth ? { authorization: auth } : {}, query: {} }, res);
  return res;
};
const DAY1 = '2026-10-01T06:00:00.000Z';
const DAY2 = '2026-10-02T06:00:00.000Z';
const DAY3 = '2026-10-03T06:00:00.000Z';
const clockAt = (iso) => () => new Date(iso);

const mkPlace = (id, over = {}) => ({
  id,
  displayName: { text: over.name || 'Fresh Shop ' + id },
  formattedAddress: '',
  addressComponents: [
    { types: ['street_number'], longText: over.num || '100' },
    { types: ['route'], longText: over.route || 'Main St' },
    { types: ['locality'], longText: over.city || 'Kansas City' },
    { types: ['administrative_area_level_1'], shortText: over.state || 'MO', longText: 'x' },
    { types: ['postal_code'], longText: over.zip || '64108' },
  ],
  nationalPhoneNumber: over.phone || '816-555-0100',
  websiteUri: over.websiteUri || '',
  businessStatus: over.businessStatus || 'OPERATIONAL',
  regularOpeningHours: over.hours === null ? undefined : { weekdayDescriptions: over.hours || ['Monday: 8:00 AM – 5:00 PM', 'Tuesday: 8:00 AM – 5:00 PM'] },
  primaryTypeDisplayName: { text: over.category || 'Auto repair shop' },
  rating: over.rating === undefined ? 4.6 : over.rating,
  userRatingCount: over.reviews === undefined ? 42 : over.reviews,
});
const placesResp = (places) => ({ places });

const PLAN = [{ trade: 'auto repair', city: 'Kansas City' }, { trade: 'dentist', city: 'Olathe' }];
const armDiscovery = async (over = {}) => disc.saveDiscConfig({ enabled: true, perRunCap: 5, dailyCap: 20, slotsPerRun: 1, plan: PLAN, ...over });
const armDraft = async (over = {}) => draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0, ...over });
const seedLegacy = async (leads) => { await cmd(['SET', 'ks:leads', JSON.stringify(leads)]); };
const LEGACY_LEAD = { id: 'md5oflegacy1', name: 'Legacy Motors', trade: 'auto repair', city: 'Kansas City', state: 'MO', street: '100 Main St', zip: '64108', phone: '816-555-0100' };
const getCands = async () => Object.values(parseHash(await cmd(['HGETALL', 'ks:disc:cands']))).filter(Boolean);
const siteBodies = async () => {
  const out = [];
  for (const k of KV.keys()) if (k.startsWith('ks:site:')) { try { out.push(JSON.parse(KV.get(k))); } catch {} }
  return out;
};

// ---- A. CRON AUTH FAILS CLOSED ----
console.log('\nA. CRON AUTH');
{
  seed();
  delete process.env.CRON_SECRET;
  const r1 = await callCron(cronDiscovery, 'Bearer cronsecret');
  check('no CRON_SECRET -> 401 even with a bearer presented', r1.code === 401 && r1.body.error === 'unauthorized');
  process.env.CRON_SECRET = 'cronsecret';
  const r2 = await callCron(cronDiscovery, 'Bearer wrongsecret');
  check('wrong CRON_SECRET -> 401', r2.code === 401);
  const r3 = await callCron(cronDiscovery, null);
  check('no Authorization header -> 401, no state leak', r3.code === 401 && !r3.body.reason);
  const r4 = await callCron(cronDraft, 'Bearer wrongsecret');
  check('cron-draft: wrong secret -> 401', r4.code === 401);
  const r5 = await callCron(cronDiscovery, 'Bearer cronsecret');
  check('correct Bearer -> allowed (discovery disabled, zero Places calls)', r5.code === 200 && r5.body.reason === 'disabled' && placesCalls === 0);
}

// ---- B. DISCOVERY -> DEDUPE -> RANKED (and the cron handler drives it) ----
console.log('\nB. DISCOVERY RUN A VIA CRON HANDLER');
{
  seed();
  await armDiscovery();
  placesQueue = [placesResp([
    mkPlace('P1', { name: 'Alpha Auto', rating: 4.9, reviews: 99 }),
    mkPlace('P2', { name: 'Beta Brakes', phone: '816-555-0177', rating: 4.0, reviews: 10 }),
  ])];
  const res = await callCron(cronDiscovery, 'Bearer cronsecret');
  const cands = await getCands();
  check('run A completes through the real handler', res.code === 200 && res.body.reason === 'completed');
  check('exactly one Places call (one page, bounded)', placesCalls === 1, 'calls=' + placesCalls);
  check('both results persisted as ranked candidates', cands.length === 2 && cands.every((c) => c.status === 'ranked'));
  const p1 = cands.find((c) => c.placeId === 'P1');
  check('placeId is the canonical identity', !!p1 && p1.firstRunId && p1.lastRunId);
  check('provider facts keep provenance (hours verbatim from Places)',
    Array.isArray(p1.hours) && p1.hours.length === 2 && p1.hours[0].d === 'Monday' && p1.hours[0].h.includes('8:00'));
}

// ---- C. REPEATED DISCOVERY: NO DUPLICATES, PLAN ADVANCES, THEN CAUGHT UP ----
console.log('\nC. DISCOVERY RUN A AGAIN (same day)');
{
  seed();
  await armDiscovery();
  placesQueue = [placesResp([
    mkPlace('P1', { name: 'Alpha Auto', rating: 4.9, reviews: 99 }),
    mkPlace('P2', { name: 'Beta Brakes', phone: '816-555-0177', rating: 4.0, reviews: 10 }),
  ])];
  const r1 = await disc.runDiscovery({ clock: clockAt(DAY1) });
  check('run A completes (slot 1)', r1.reason === 'completed' && (await getCands()).length === 2);
  placesQueue = [placesResp([
    mkPlace('P1', { name: 'Alpha Auto', rating: 4.9, reviews: 99 }), // rediscovered
    mkPlace('P3', { name: 'Olathe Dental', city: 'Olathe', state: 'KS', zip: '66061', phone: '913-555-0102', category: 'Dentist' }),
  ])];
  const r2 = await disc.runDiscovery({ clock: clockAt(DAY1) });
  const cands = await getCands();
  check('second invocation moves to slot 2 and adds only the new business',
    r2.reason === 'completed' && cands.length === 3, 'reason=' + r2.reason + ' cands=' + cands.length);
  const p1 = cands.find((c) => c.placeId === 'P1');
  check('rediscovered business merges, never duplicates', !!p1 && (p1.queries || []).length >= 1);
  const callsBefore = placesCalls;
  const r3 = await disc.runDiscovery({ clock: clockAt(DAY1) });
  check('third invocation same day: caught_up, ZERO new Places calls, zero new candidates',
    r3.reason === 'caught_up' && placesCalls === callsBefore && (await getCands()).length === 3);
}

// ---- D. DUPLICATE AGAINST THE LEGACY POOL (K4) ----
console.log('\nD. LEGACY QUEUE DEDUPE AT DISCOVERY');
{
  seed();
  await armDiscovery();
  await seedLegacy([LEGACY_LEAD]);
  placesQueue = [placesResp([
    mkPlace('L1', { name: 'Legacy Motors', phone: '816-555-0100' }),                                    // phone + name/city + address
    mkPlace('L2', { name: 'legacy MOTORS', phone: '816-555-9999', num: '500', route: 'Oak St', zip: '64111' }), // name+city only
    mkPlace('L3', { name: 'Different Name', phone: '816-555-8888' }),                                    // address only (same street+zip)
    mkPlace('L4', { name: 'Actually New', phone: '816-555-1212', num: '900', route: 'Far Ave', zip: '64120' }),
  ])];
  await disc.runDiscovery({ clock: clockAt(DAY1) });
  const cands = await getCands();
  const by = (id) => cands.find((c) => c.placeId === id);
  check('phone match against legacy queue -> excluded existing_queue', by('L1').status === 'excluded' && by('L1').excludeReason === 'existing_queue');
  check('exact name+city match (different phone/address) -> excluded', by('L2').status === 'excluded' && by('L2').excludeReason === 'existing_queue');
  check('address fingerprint match (different name/phone) -> excluded', by('L3').status === 'excluded' && by('L3').excludeReason === 'existing_queue');
  check('genuinely new business still ranks', by('L4').status === 'ranked');
}

// ---- E. SUPPRESSED / CLOSED / MALFORMED PROVIDER RECORDS FAIL CLOSED ----
console.log('\nE. EXCLUSIONS + MALFORMED PROVIDER');
{
  seed();
  await armDiscovery();
  await suppressContact({ phone: '816-555-6666', name: 'Stop Shop' }, { reason: 'do not contact', actor: 'test', source: 'manual' });
  placesQueue = [placesResp([
    mkPlace('S1', { name: 'Stop Shop', phone: '816-555-6666' }),
    mkPlace('S2', { name: 'Closed Shop', phone: '816-555-7777', businessStatus: 'CLOSED_PERMANENTLY' }),
    { displayName: { text: 'No Place ID' } }, // malformed: no id -> fail closed, never persisted
    mkPlace('S3', { name: 'Fine Shop', phone: '816-555-4444' }),
  ])];
  await disc.runDiscovery({ clock: clockAt(DAY1) });
  const cands = await getCands();
  const by = (id) => cands.find((c) => c.placeId === id);
  check('suppressed business -> excluded suppressed', by('S1').status === 'excluded' && by('S1').excludeReason === 'suppressed');
  check('non-operational business -> excluded not_operational', by('S2').status === 'excluded' && by('S2').excludeReason === 'not_operational');
  check('record without a Place ID is never persisted (no invented identity)', cands.length === 3 && !cands.some((c) => !c.placeId));
  check('clean record still ranks', by('S3').status === 'ranked');
}
{
  seed();
  await armDiscovery();
  placesFail = { status: 500 };
  const r = await disc.runDiscovery({ clock: clockAt(DAY1) });
  check('provider 5xx -> run fails, ZERO fake candidates', r.reason === 'failed' && (await getCands()).length === 0);
  placesFail = 'malformed';
  const r2 = await disc.runDiscovery({ clock: clockAt(DAY2) });
  check('malformed provider body -> run fails, ZERO fake candidates', r2.reason === 'failed' && (await getCands()).length === 0);
}

// ---- F. K4 -> K5: SUCCESSFUL UNPUBLISHED FACTUAL DRAFT ----
console.log('\nF. RANKED -> DRAFTED (K4 hands to K5 with no operator step)');
{
  seed();
  await armDiscovery();
  await armDraft();
  placesQueue = [placesResp([
    mkPlace('P1', { name: 'Alpha Auto', rating: 4.9, reviews: 99 }),
    mkPlace('P2', { name: 'Beta Brakes', phone: '816-555-0177' }),
  ])];
  await disc.runDiscovery({ clock: clockAt(DAY1) });
  const dr = await draftAuto.runDraftAutonomy({ clock: clockAt(DAY1) });
  const cands = await getCands();
  const bodies = await siteBodies();
  check('draft run completes and consumes ranked candidates', dr.reason === 'completed' && dr.run.drafted === 2, JSON.stringify({ reason: dr.reason, drafted: dr.run && dr.run.drafted }));
  check('candidates are marked drafted with a slug', cands.every((c) => c.draftStatus === 'drafted' && c.draftSlug));
  check('drafts are UNPUBLISHED and unclaimed', bodies.length === 2 && bodies.every((s) => s.published === false && s.claimed === false));
  const p1body = bodies.find((s) => s.placeId === 'P1');
  check('draft is factual: real name, phone, provider hours — nothing invented',
    p1body.business === 'Alpha Auto' && String(p1body.phone).includes('816') && Array.isArray(p1body.hours) && p1body.hours.length === 2);
}

// ---- G. SECOND DRAFT INVOCATION = NO DUPLICATE; NEXT DAY STILL NO DUPLICATE ----
console.log('\nG. DRAFT IDEMPOTENCY');
{
  // continues from F
  const sameDay = await draftAuto.runDraftAutonomy({ clock: clockAt(DAY1) });
  check('same-day second run -> caught_up', sameDay.reason === 'caught_up' && sameDay.drafts === 0);
  const nextDay = await draftAuto.runDraftAutonomy({ clock: clockAt(DAY2) });
  const bodies = await siteBodies();
  check('next-day run creates ZERO new drafts (placeId index reconciles)',
    nextDay.run && nextDay.run.drafted === 0 && bodies.length === 2, JSON.stringify({ drafted: nextDay.run && nextDay.run.drafted, bodies: bodies.length }));
  check('no slug-2 duplicates exist', new Set(bodies.map((s) => s.slug)).size === bodies.length);
}

// ---- G2. PER-INVOCATION RUN IDENTITY: EVERY SCHEDULED SLOT CAN CONSUME ----
console.log('\nG2. PER-HOUR RUNS CONSUME FRESH INVENTORY (4x/day cron actually works)');
{
  seed();
  await armDraft({ draftsPerRun: 1 });
  const cand = (id, name, phone, street, score) => ({
    placeId: id, name, slotTrade: 'auto repair', category: 'Auto repair shop',
    city: 'Kansas City', state: 'MO', street, zip: '64108', phone,
    status: 'ranked', score, businessStatus: 'OPERATIONAL', webStatus: 'no_site',
  });
  await cmd(['HSET', 'ks:disc:cands', 'H1', JSON.stringify(cand('H1', 'Hour One Auto', '816-555-0001', '1 First St', 3))]);
  await cmd(['HSET', 'ks:disc:cands', 'H2', JSON.stringify(cand('H2', 'Hour Two Auto', '816-555-0002', '2 Second St', 2))]);

  const r1 = await draftAuto.runDraftAutonomy({ clock: clockAt('2026-10-01T06:00:00.000Z') });
  check('06:00 run drafts the highest scorer, run id carries the UTC hour',
    r1.reason === 'completed' && r1.run.drafted === 1 && r1.run.id === 'draft-run-20261001-06', r1.run && r1.run.id);
  const r2 = await draftAuto.runDraftAutonomy({ clock: clockAt('2026-10-01T06:20:00.000Z') });
  check('same-hour replay -> caught_up (retry idempotent, cap accounting intact)',
    r2.reason === 'caught_up' && r2.drafts === 0);
  const r3 = await draftAuto.runDraftAutonomy({ clock: clockAt('2026-10-01T07:00:00.000Z') });
  check('next-hour run is NOT caught_up: consumes the next ranked candidate',
    r3.reason === 'completed' && r3.run.drafted === 1 && r3.run.id === 'draft-run-20261001-07', r3.run && r3.run.id);
  const bodies = await siteBodies();
  check('two hourly runs -> two distinct unpublished drafts, no duplicate',
    bodies.length === 2 && new Set(bodies.map((s) => s.slug)).size === 2 && bodies.every((s) => s.published === false && s.claimed === false));
  const r4 = await draftAuto.runDraftAutonomy({ clock: clockAt('2026-10-01T08:00:00.000Z') });
  check('empty backlog hour -> completes cleanly, drafts nothing', r4.reason === 'completed' && r4.run.drafted === 0 && (await siteBodies()).length === 2);
}

// ---- H. QUALITY GATE: INCOMPLETE FACTS CANNOT BECOME A DRAFT ----
console.log('\nH. QUALITY GATE');
{
  seed();
  await armDraft();
  await cmd(['HSET', 'ks:disc:cands', 'Q1', JSON.stringify({
    placeId: 'Q1', name: 'Thin Record', slotTrade: '', category: '',
    city: '', state: '', street: '', zip: '', phone: '',
    status: 'ranked', score: 3, businessStatus: 'OPERATIONAL', webStatus: 'no_site',
  })]);
  const dr = await draftAuto.runDraftAutonomy({ clock: clockAt(DAY1) });
  const q1 = (await getCands())[0];
  check('factually empty candidate is quality_blocked, never marked drafted',
    dr.reason === 'completed' && q1.draftStatus === 'excluded' && q1.draftExcludeReason === 'quality_blocked');
  check('no site body exists for the blocked candidate', (await siteBodies()).length === 0);
}

// ---- I. K5 RE-DERIVES LEGACY EXCLUSION AT DRAFT TIME ----
console.log('\nI. K5 LEGACY EXCLUSION (candidate slipped in ranked)');
{
  seed();
  await armDraft();
  await seedLegacy([LEGACY_LEAD]);
  await cmd(['HSET', 'ks:disc:cands', 'X1', JSON.stringify({
    placeId: 'X1', name: 'Legacy Motors', slotTrade: 'auto repair', category: 'Auto repair shop',
    city: 'Kansas City', state: 'MO', street: '100 Main St', zip: '64108', phone: '816-555-0100',
    status: 'ranked', score: 3, businessStatus: 'OPERATIONAL', webStatus: 'no_site',
  })]);
  const dr = await draftAuto.runDraftAutonomy({ clock: clockAt(DAY1) });
  const x1 = (await getCands())[0];
  check('ranked candidate matching the legacy queue is excluded at draft time',
    dr.reason === 'completed' && x1.draftStatus === 'excluded' && x1.draftExcludeReason === 'existing_queue');
  check('no draft created for it', (await siteBodies()).length === 0);
}

// ---- J. MULTI-RUN REPLENISHMENT + K6 POOL ----
console.log('\nJ. INVENTORY GROWS ACROSS RUNS AND ENTERS THE OUTREACH POOL ONCE');
{
  seed();
  await armDiscovery();
  await armDraft({ draftsPerRun: 1 });
  await seedLegacy([LEGACY_LEAD]); // one in-queue legacy business

  placesQueue = [placesResp([mkPlace('P1', { name: 'Alpha Auto', phone: '816-555-4242', num: '42', route: 'Alpha Ln', zip: '64114', rating: 4.9, reviews: 99 })])];
  await disc.runDiscovery({ clock: clockAt(DAY1) });
  await draftAuto.runDraftAutonomy({ clock: clockAt(DAY1) });

  placesQueue = [placesResp([mkPlace('P3', { name: 'Olathe Dental', city: 'Olathe', state: 'KS', zip: '66061', phone: '913-555-0102', category: 'Dentist' })])];
  await disc.runDiscovery({ clock: clockAt(DAY2) });
  await draftAuto.runDraftAutonomy({ clock: clockAt(DAY2) });

  placesQueue = [placesResp([mkPlace('P4', { name: 'Third Wave Auto', num: '1', route: 'Wave Way', zip: '64130', phone: '816-555-3131', rating: 4.2, reviews: 12 })])];
  await disc.runDiscovery({ clock: clockAt(DAY3) });
  await draftAuto.runDraftAutonomy({ clock: clockAt(DAY3) });

  const cands = await getCands();
  check('three discovery windows produced three fresh candidates', cands.length === 3 && cands.every((c) => c.status === 'ranked'),
    JSON.stringify(cands.map((c) => ({ id: c.placeId, status: c.status, ex: c.excludeReason, ds: c.draftStatus, slug: c.draftSlug }))));
  check('three draft runs produced three distinct unpublished drafts', cands.every((c) => c.draftStatus === 'drafted') && (await siteBodies()).length === 3);

  const { legacyQueued, drafted, pool } = await postcardCandidatePool();
  check('pool = legacy queue + drafted inventory', legacyQueued.length === 1 && drafted.length === 3 && pool.length === 4);
  check('no drafted entry duplicates the legacy business identity',
    !drafted.some((l) => l.name === 'Legacy Motors' || l.phone === LEGACY_LEAD.phone));
}
{
  // A PRE-FIX drafted candidate duplicating a legacy business must be kept out
  // of the pool by the strong-identity filter even though ids differ.
  seed();
  await seedLegacy([LEGACY_LEAD]);
  await cmd(['HSET', 'ks:disc:cands', 'OLD1', JSON.stringify({
    placeId: 'OLD1', name: 'Legacy Motors', slotTrade: 'auto repair',
    city: 'Kansas City', state: 'MO', street: '100 Main St', zip: '64108', phone: '816-555-0100',
    status: 'ranked', draftStatus: 'drafted', draftSlug: 'legacy-motors-kansas-city', businessStatus: 'OPERATIONAL',
  })]);
  const { legacyQueued, drafted, pool } = await postcardCandidatePool();
  check('pool dedupe: legacy-matching drafted candidate never double-enters the send pool',
    legacyQueued.length === 1 && drafted.length === 0 && pool.length === 1);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
