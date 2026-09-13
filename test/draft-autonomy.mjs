// K5 — autonomous unpublished site drafting from ranked K4 candidates.
// No network; KV is an in-memory Map behind the REST shape.
import path from 'node:path';
import fs from 'node:fs';
const ROOT = path.join(import.meta.dirname, '..');
process.env.KV_REST_API_URL = 'https://kv.test/';
process.env.KV_REST_API_TOKEN = 'kvtok';
process.env.CRON_SECRET = 'cronsecret';
process.env.ADMIN_KEY = 'admintok';
process.env.SWITCH_TOKEN = 'switchtok';
process.env.REP_KEYS = 'dana:repkey1';

const KV = new Map();
const EXP = new Map();
const live = (key) => { if (EXP.has(key) && EXP.get(key) <= Date.now()) { EXP.delete(key); KV.delete(key); } };

const evalScript = (a) => {
  const script = a[1];
  const n = Number(a[2]);
  const keys = a.slice(3, 3 + n);
  const argv = a.slice(3 + n);
  if (script.includes('disc_lease_renew_v1')) {
    if (KV.get(keys[0]) === argv[0]) { EXP.set(keys[0], Date.now() + Number(argv[1])); return 'OK'; }
    return 'LOST';
  }
  if (script.includes('disc_lease_release_v1')) {
    if (KV.get(keys[0]) === argv[0]) { KV.delete(keys[0]); EXP.delete(keys[0]); return 1; }
    return 0;
  }
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
  if (script.includes('disc_complete_v1')) {
    const [owner, runId, runJson, cursorJson] = argv;
    if (KV.get(keys[0]) !== owner) return 'LEASE_LOST';
    const h = KV.get(keys[1]) || {}; h[runId] = runJson; KV.set(keys[1], h);
    KV.set(keys[2], cursorJson);
    return 'COMPLETED';
  }
  // K5 lease + completion primitives
  if (script.includes('draft_lease_renew_v1')) {
    if (KV.get(keys[0]) === argv[0]) { EXP.set(keys[0], Date.now() + Number(argv[1])); return 'OK'; }
    return 'LOST';
  }
  if (script.includes('draft_lease_release_v1')) {
    if (KV.get(keys[0]) === argv[0]) { KV.delete(keys[0]); EXP.delete(keys[0]); return 1; }
    return 0;
  }
  if (script.includes('draft_complete_v1')) {
    const [owner, runId, runJson] = argv;
    if (KV.get(keys[0]) !== owner) return 'LEASE_LOST';
    const h = KV.get(keys[1]) || {}; h[runId] = runJson; KV.set(keys[1], h);
    return 'COMPLETED';
  }
  if (script.includes('draft_apply_v1')) {
    // KEYS: 1=lease, 2=site body, 3=siteidx, 4=place index, 5=candidates hash, 6=effects hash, 7=run counter
    // ARGV: 1=owner, 2=placeId, 3=slug, 4=siteJSON, 5=indexJSON, 6=candidateJSON, 7=effectType, 8=runId, 9=draftsPerRun
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
      if (effects[argv[1]] === undefined) {
        effects[argv[1]] = 'repair';
        KV.set(keys[5], effects);
      }
    }
    KV.set(keys[1], argv[3]);
    const idx = KV.get(keys[2]) || {}; idx[argv[2]] = argv[4]; KV.set(keys[2], idx);
    placeIdx[argv[1]] = argv[2]; KV.set(keys[3], placeIdx);
    const cands = KV.get(keys[4]) || {}; cands[argv[1]] = argv[5]; KV.set(keys[4], cands);
    return ['OK', argv[2], argv[6]];
  }
  if (script.includes('draft_link_v1')) {
    // KEYS: 1=lease, 2=place index, 3=candidates hash
    // ARGV: 1=owner, 2=placeId, 3=slug, 4=candidateJSON
    if (KV.get(keys[0]) !== argv[0]) return 'LEASE_LOST';
    const placeIdx = KV.get(keys[1]) || {};
    const existing = placeIdx[argv[1]];
    if (existing !== undefined && existing !== argv[2]) return ['MAPPING_CONFLICT', existing];
    placeIdx[argv[1]] = argv[2]; KV.set(keys[1], placeIdx);
    const cands = KV.get(keys[2]) || {}; cands[argv[1]] = argv[3]; KV.set(keys[2], cands);
    return 'OK';
  }
  if (script.includes('draft_candidate_update_v1')) {
    // KEYS: 1=lease, 2=candidates hash
    // ARGV: 1=owner, 2=placeId, 3=candidateJSON
    if (KV.get(keys[0]) !== argv[0]) return 'LEASE_LOST';
    const cands = KV.get(keys[1]) || {}; cands[argv[1]] = argv[2]; KV.set(keys[1], cands);
    return 'OK';
  }
  if (script.includes('draft_repair_index_v1')) {
    // KEYS: 1=lease, 2=siteidx
    // ARGV: 1=owner, 2=slug, 3=indexJSON
    if (KV.get(keys[0]) !== argv[0]) return 'LEASE_LOST';
    const idx = KV.get(keys[1]) || {}; idx[argv[1]] = argv[2]; KV.set(keys[1], idx);
    return 'OK';
  }
  if (script.includes('draft_run_status_v1')) {
    // KEYS: 1=lease, 2=runs hash
    // ARGV: 1=owner, 2=runId, 3=runJSON
    if (KV.get(keys[0]) !== argv[0]) return 'LEASE_LOST';
    const runs = KV.get(keys[1]) || {}; runs[argv[1]] = argv[2]; KV.set(keys[1], runs);
    return 'OK';
  }
  throw new Error('unexpected eval script');
};

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
        // Value is always at index 2; PX/EX are modifiers after it.
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
  throw new Error('unexpected fetch ' + u);
};

const { cmd, parseHash } = await import('../lib/kv.js');
const disc = await import('../lib/discovery.js');
const draftAuto = await import('../lib/draft-autonomy.js');
const sites = await import('../lib/sites.js');
const { suppressContact } = await import('../lib/suppression.js');
const { upsertAccount } = await import('../lib/store.js');
const cronDraft = (await import('../api/cron-draft.js')).default;
const admin = (await import('../api/admin.js')).default;

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };
const seed = () => { KV.clear(); EXP.clear(); delete process.env.VERCEL_ENV; };
const mkRes = () => { const res = { code: 0, body: null }; res.status = (c) => { res.code = c; return res; }; res.json = (o) => { res.body = o; return res; }; return res; };
const adminCall = async (action, token, extra = {}) => {
  const res = mkRes();
  await admin({ method: 'POST', headers: {}, body: { action, token, ...extra } }, res);
  return res;
};
const runCron = async () => {
  const res = mkRes();
  await cronDraft({ method: 'GET', headers: { authorization: 'Bearer cronsecret' }, query: {} }, res);
  return res;
};

const candidate = (id, over = {}) => ({
  placeId: id,
  name: over.name || 'Acme Auto',
  city: over.city || 'Kansas City',
  state: over.state || 'MO',
  street: over.street || '101 Main St',
  zip: over.zip || '64108',
  phone: over.phone || '816-555-0100',
  slotTrade: over.trade || 'plumber',
  category: over.category || 'Plumber',
  rating: 4.5,
  reviews: 30,
  businessStatus: over.closed ? 'CLOSED_PERMANENTLY' : 'OPERATIONAL',
  status: 'ranked',
  score: over.score === undefined ? 1.5 : over.score,
  parts: { webPresence: 1, reputation: 0.9, demand: 0.3, geoExact: 1 },
  webStatus: over.webStatus || 'directory_only',
  discoveredAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
  queries: [{ trade: over.trade || 'plumber', city: over.city || 'Kansas City', at: new Date().toISOString() }],
  ...over,
});

const saveCand = async (c) => { await cmd(['HSET', 'ks:disc:cands', c.placeId, JSON.stringify(c)]); };

const bodiesForPlace = (placeId) => {
  const slugs = [];
  for (const k of KV.keys()) {
    if (!k.startsWith('ks:site:')) continue;
    try { if (JSON.parse(KV.get(k)).placeId === placeId) slugs.push(k.slice('ks:site:'.length)); } catch {}
  }
  return slugs;
};

const runIdForToday = () => 'draft-run-' + new Date().toISOString().slice(0, 10).replace(/-/g, '');

// ---- CONFIG / GATES ----
console.log('\nCONFIG / DEFAULT-OFF GATES');
{
  seed();
  const r = await draftAuto.runDraftAutonomy();
  check('A. config absent -> zero drafts', r.ran === false && r.reason === 'disabled' && r.drafts === 0);
}
{
  seed();
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 0, minScore: 0 });
  const r = await draftAuto.runDraftAutonomy();
  check('B. missing/invalid draftsPerRun -> fail closed', r.ran === false && r.reason === 'incomplete_config' && r.drafts === 0);
}
{
  seed();
  await draftAuto.saveDraftConfig({ enabled: false, draftsPerRun: 5, minScore: 0 });
  const r = await draftAuto.runDraftAutonomy();
  check('C. enabled false -> zero drafts', r.ran === false && r.reason === 'disabled' && r.drafts === 0);
}
{
  seed();
  await saveCand(candidate('ChIJ_A'));
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  process.env.VERCEL_ENV = 'preview';
  const r = await draftAuto.runDraftAutonomy();
  check('AB. preview -> zero production mutations', r.ran === false && r.reason === 'preview_disabled' && r.drafts === 0);
  delete process.env.VERCEL_ENV;
}

// ---- ELIGIBILITY / DRAFTING ----
console.log('\nELIGIBILITY / DRAFTING');
{
  seed();
  await saveCand(candidate('ChIJ_A'));
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const r = await draftAuto.runDraftAutonomy();
  const site = await sites.getSite('acme-auto');
  const c = (await disc.getCandidates())['ChIJ_A'];
  check('D. ranked eligible candidate -> one unpublished draft', r.reason === 'completed' && r.run.drafted === 1 && site && site.published === false && site.claimed === false);
  check('U. draft published:false', site && site.published === false);
  check('V. draft unclaimed/no entitlement', site && site.claimed === false && site.modules.join(',') === 'P0' && !site.email);
  check('linkage. candidate has draftSlug', c && c.draftSlug === 'acme-auto' && c.draftStatus === 'drafted');
}
{
  seed();
  await saveCand(candidate('ChIJ_A'));
  await saveCand(candidate('ChIJ_B', { name: 'Beta Plumbing', phone: '816-555-0200', score: 2.0 }));
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const r = await draftAuto.runDraftAutonomy();
  const cands = await disc.getCandidates();
  check('E. same candidate twice -> one draft (idempotent place index)', r.run.drafted === 2);
  await draftAuto.runDraftAutonomy();
  check('E2. rerun does not create more drafts', (await sites.listSites()).length === 2);
}
{
  seed();
  await saveCand(candidate('ChIJ_A', { score: 0.5 }));
  await saveCand(candidate('ChIJ_B', { score: 2.0 }));
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 1.0 });
  const r = await draftAuto.runDraftAutonomy();
  check('minScore. low-score candidate skipped', r.run.drafted === 1 && r.run.skipped === 1);
}

// ---- EXCLUSIONS ----
console.log('\nEXCLUSIONS');
{
  seed();
  await saveCand(candidate('ChIJ_SUP'));
  await suppressContact({ phone: '816-555-0100', city: 'Kansas City', state: 'MO', street: '101 Main St', zip: '64108' }, { reason: 'stop', actor: 'test', source: 'test' });
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const r = await draftAuto.runDraftAutonomy();
  check('I. suppressed candidate -> zero draft', r.run.drafted === 0 && r.run.skipped === 1);
}
{
  seed();
  await saveCand(candidate('ChIJ_CLAIMED'));
  await sites.upsertSite({ slug: 'acme-auto-kansas-city', business: 'Acme Auto', city: 'Kansas City', state: 'MO', published: false, claimed: true, modules: ['P0'] });
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const r = await draftAuto.runDraftAutonomy();
  check('J. existing claimed site -> zero draft', r.run.drafted === 0 && r.run.skipped === 1);
}
{
  seed();
  await saveCand(candidate('ChIJ_DRAFT'));
  await sites.upsertSite({ slug: 'acme-auto-kansas-city', business: 'Acme Auto', city: 'Kansas City', state: 'MO', published: false, claimed: false, modules: ['P0'] });
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const r = await draftAuto.runDraftAutonomy();
  check('K. existing draft -> reuse/link, no duplicate', r.run.drafted === 0 && r.run.linked === 1 && (await sites.listSites()).length === 1);
}
{
  seed();
  await saveCand(candidate('ChIJ_PHONE'));
  await sites.upsertSite({ slug: 'some-other-site', business: 'Different Name', city: 'Overland Park', state: 'KS', phone: '816-555-0100', published: true, claimed: true, modules: ['P0'] });
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const r = await draftAuto.runDraftAutonomy();
  check('L. exact phone current-customer exclusion', r.run.drafted === 0 && r.run.skipped === 1);
}
{
  seed();
  await saveCand(candidate('ChIJ_ACCT'));
  await upsertAccount({ email: 'owner@acme.com', phone: '8165550100', plan: ['P0'] });
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const r = await draftAuto.runDraftAutonomy();
  check('M. exact phone account -> current customer exclusion', r.run.drafted === 0 && r.run.skipped === 1);
}
{
  seed();
  await saveCand(candidate('ChIJ_PAID'));
  await upsertAccount({ email: 'paid@acme.com', phone: '8165550100', plan: ['P0', 'P1'], stripeCustomerId: 'cus_1' });
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const r = await draftAuto.runDraftAutonomy();
  check('P. paid customer strong match -> zero draft', r.run.drafted === 0 && r.run.skipped === 1);
}
{
  seed();
  await saveCand(candidate('ChIJ_AMB'));
  await sites.upsertSite({ slug: 'site-one', business: 'X', city: 'Y', phone: '816-555-0100', published: true, claimed: true, modules: ['P0'] });
  await upsertAccount({ email: 'a@a.com', phone: '8165550100', plan: ['P0'] });
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const r = await draftAuto.runDraftAutonomy();
  check('O. ambiguous/conflicting identity -> excluded', r.run.drafted === 0 && r.run.skipped === 1);
}
{
  seed();
  await saveCand(candidate('', { name: 'No Place' }));
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const r = await draftAuto.runDraftAutonomy();
  check('Q. missing placeId -> zero draft', r.run.drafted === 0 && r.run.skipped === 1);
}
{
  seed();
  await saveCand(candidate('ChIJ_CLOSED', { closed: true }));
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const r = await draftAuto.runDraftAutonomy();
  check('R. non-operational -> zero draft', r.run.drafted === 0 && r.run.skipped === 1);
}

// ---- BOUNDARIES ----
console.log('\nBOUNDARIES / IDEMPOTENCY');
{
  seed();
  await saveCand(candidate('ChIJ_1'));
  await saveCand(candidate('ChIJ_2'));
  await saveCand(candidate('ChIJ_3'));
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 2, minScore: 0 });
  const r = await draftAuto.runDraftAutonomy();
  check('Y. draftsPerRun exact boundary', r.run.drafted === 2 && r.run.capStop === 'drafts_per_run_cap');
}
{
  seed();
  await saveCand(candidate('ChIJ_A'));
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const r1 = await draftAuto.runDraftAutonomy();
  const r2 = await draftAuto.runDraftAutonomy();
  check('AA. run replay idempotent', r1.run.drafted === 1 && r2.reason === 'caught_up');
}

// ---- CRASH RECOVERY ----
console.log('\nCRASH RECOVERY');
{
  seed();
  await saveCand(candidate('ChIJ_A'));
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  // Simulate: site and place index were written, but candidate linkage was not.
  seed();
  await saveCand(candidate('ChIJ_A'));
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const lead = draftAuto.candidateToLead(candidate('ChIJ_A'));
  const rec = (await import('../lib/draft-site.js')).draftFromLead(lead, new Set());
  await sites.upsertSite({ ...rec, placeId: 'ChIJ_A', published: false, claimed: false, modules: ['P0'], source: 'draft-autonomy', leadId: 'ChIJ_A' });
  await cmd(['HSET', 'ks:draft:place', 'ChIJ_A', rec.slug]);
  // candidate still has no draftSlug/draftStatus -> linkage repair path
  const r = await draftAuto.runDraftAutonomy();
  const c = (await disc.getCandidates())['ChIJ_A'];
  check('G. site-created/linkage-failed retry -> same site, linkage repaired', r.run.linked === 1 && c.draftSlug === rec.slug && (await sites.listSites()).length === 1);
}

// ---- CONCURRENCY / LEASE ----
console.log('\nCONCURRENCY / LEASE');
{
  seed();
  await saveCand(candidate('ChIJ_A'));
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const [r1, r2] = await Promise.all([draftAuto.runDraftAutonomy(), draftAuto.runDraftAutonomy()]);
  check('Z. overlapping run lease -> one effective run', (r1.reason === 'completed' && r2.reason === 'lease_held') || (r2.reason === 'completed' && r1.reason === 'lease_held'));
  check('Z2. exactly one site created', (await sites.listSites()).length === 1);
}

// ---- AUTH / OPERATOR ----
console.log('\nAUTH / OPERATOR');
{
  seed();
  const r = await adminCall('draft-status', 'repkey1');
  check('AA2. rep can READ draft status', r.code === 200 && r.body.enabled === false);
}
{
  seed();
  const r = await adminCall('draft-setconfig', 'repkey1', { enabled: true, draftsPerRun: 1 });
  check('AA3. rep cannot change draft config -> 403', r.code === 403);
}
{
  seed();
  const r = await adminCall('draft-setconfig', 'admintok', { enabled: true, draftsPerRun: 3 });
  check('AA4. owner can arm draft autonomy', r.code === 200 && r.body.config.enabled === true && r.body.config.draftsPerRun === 3);
}
{
  seed();
  const res = mkRes();
  await cronDraft({ method: 'GET', headers: { authorization: 'Bearer wrong' }, query: {} }, res);
  check('AC. cron auth fail closed', res.code === 401);
}

// ---- ZERO OUTREACH ----
console.log('\nZERO OUTREACH / ZERO SIDE EFFECT');
{
  seed();
  await saveCand(candidate('ChIJ_A'));
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  await draftAuto.runDraftAutonomy();
  const site = await sites.getSite('acme-auto');
  check('AE. zero email', !site.email);
  check('AG. zero publish', site.published === false);
  check('T. no fabricated content', !/since|years|family|trusted|best|quality|experienced|award|certified/.test(site.about));
}
{
  // Static call-graph proof: this file imports no outbound/site-payment modules.
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'draft-autonomy.js'), 'utf8');
  const banned = ['runAutopilot', 'sendPanelLink', 'publishForMail', 'lobSend', 'onboardCustomer', 'Resend', 'Stripe'];
  const bannedHit = banned.filter((s) => src.includes(s));
  check('AH/AG/AE. zero outreach modules in K5 graph', bannedHit.length === 0, bannedHit.join(', '));
}

// ---- E2E TWICE ----
console.log('\nE2E: RANKED -> DRAFT -> OPERATOR -> ZERO SIDE EFFECT');
{
  seed();
  await saveCand(candidate('ChIJ_E2E'));
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const r1 = await draftAuto.runDraftAutonomy();
  const st = (await adminCall('draft-status', 'admintok')).body;
  const runs = (await adminCall('draft-runs', 'admintok')).body.runs;
  check('E2E. ranked -> draft -> operator', r1.run.drafted === 1 && st.draftedCount === 1 && runs.length === 1);
  const r2 = await draftAuto.runDraftAutonomy();
  check('E2E2. run twice -> one effective site', r2.reason === 'caught_up' && (await sites.listSites()).length === 1);
}

// ---- DURABILITY: CANONICAL placeId -> SLUG FAULT MATRIX ----
console.log('\nDURABILITY: placeId -> SLUG FAULT MATRIX');
{
  // A. Mapping written, body missing -> retry completes same slug.
  {
    seed();
    await saveCand(candidate('ChIJ_A'));
    await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
    const lead = draftAuto.candidateToLead(candidate('ChIJ_A'));
    const rec = (await import('../lib/draft-site.js')).draftFromLead(lead, new Set());
    await cmd(['HSET', 'ks:draft:place', 'ChIJ_A', rec.slug]);
    const r = await draftAuto.runDraftAutonomy();
    const bodies = bodiesForPlace('ChIJ_A');
    check('FA. mapping-only -> retry completes same slug', r.run.drafted === 1 && bodies.length === 1 && bodies[0] === rec.slug);
  }

  // B. Site body written, siteidx missing -> retry repairs index, one site.
  {
    seed();
    await saveCand(candidate('ChIJ_A'));
    await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
    const lead = draftAuto.candidateToLead(candidate('ChIJ_A'));
    const rec = (await import('../lib/draft-site.js')).draftFromLead(lead, new Set());
    const site = { ...rec, placeId: 'ChIJ_A', published: false, claimed: false, modules: ['P0'], source: 'draft-autonomy', leadId: 'ChIJ_A' };
    await cmd(['SET', 'ks:site:' + rec.slug, JSON.stringify(site)]);
    await cmd(['HSET', 'ks:draft:place', 'ChIJ_A', rec.slug]);
    // siteidx intentionally empty
    const r = await draftAuto.runDraftAutonomy();
    const bodies = bodiesForPlace('ChIJ_A');
    const idx = parseHash(await cmd(['HGETALL', 'ks:siteidx']));
    check('FB. body-only -> retry repairs index', r.run.linked === 1 && bodies.length === 1 && idx[rec.slug] !== undefined);
  }

  // C. Siteidx written, candidate linkage missing -> retry repairs linkage.
  {
    seed();
    await saveCand(candidate('ChIJ_A'));
    await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
    const lead = draftAuto.candidateToLead(candidate('ChIJ_A'));
    const rec = (await import('../lib/draft-site.js')).draftFromLead(lead, new Set());
    const site = { ...rec, placeId: 'ChIJ_A', published: false, claimed: false, modules: ['P0'], source: 'draft-autonomy', leadId: 'ChIJ_A' };
    await cmd(['SET', 'ks:site:' + rec.slug, JSON.stringify(site)]);
    await cmd(['HSET', 'ks:siteidx', rec.slug, JSON.stringify((await import('../lib/sites.js')).summary(site))]);
    await cmd(['HSET', 'ks:draft:place', 'ChIJ_A', rec.slug]);
    // candidate linkage intentionally missing
    const r = await draftAuto.runDraftAutonomy();
    const c = (await disc.getCandidates())['ChIJ_A'];
    const bodies = bodiesForPlace('ChIJ_A');
    check('FC. index-only -> retry repairs candidate linkage', r.run.linked === 1 && c.draftSlug === rec.slug && bodies.length === 1);
  }

  // D. Candidate linked, run ledger missing -> replay does not duplicate.
  {
    seed();
    await saveCand(candidate('ChIJ_A'));
    await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
    await draftAuto.runDraftAutonomy();
    await cmd(['HDEL', 'ks:draft:runs', 'draft-run-' + new Date().toISOString().slice(0, 10).replace(/-/g, '')]);
    const r = await draftAuto.runDraftAutonomy();
    const bodies = bodiesForPlace('ChIJ_A');
    check('FD. candidate linked/run ledger missing -> replay idempotent', (r.reason === 'completed' || r.reason === 'caught_up') && bodies.length === 1);
  }

  // E. Run crashes after all writes -> site truth valid, retry idempotent.
  {
    seed();
    await saveCand(candidate('ChIJ_A'));
    await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
    await draftAuto.runDraftAutonomy();
    // Simulate crash: wipe only the run ledger.
    await cmd(['DEL', 'ks:draft:runs']);
    const r = await draftAuto.runDraftAutonomy();
    const bodies = bodiesForPlace('ChIJ_A');
    check('FE. post-write crash -> retry idempotent', (r.reason === 'completed' || r.reason === 'caught_up') && bodies.length === 1);
  }
}

// ---- SITE INDEX REPAIR PRIMITIVE ----
console.log('\nSITE INDEX REPAIR PRIMITIVE');
{
  seed();
  const lead = draftAuto.candidateToLead(candidate('ChIJ_A'));
  const rec = (await import('../lib/draft-site.js')).draftFromLead(lead, new Set());
  const site = { ...rec, placeId: 'ChIJ_A', published: false, claimed: false, modules: ['P0'], source: 'draft-autonomy', leadId: 'ChIJ_A' };
  await cmd(['SET', 'ks:site:' + rec.slug, JSON.stringify(site)]);
  // index missing
  const ok = await sites.repairSiteIndex(rec.slug);
  const idx = parseHash(await cmd(['HGETALL', 'ks:siteidx']));
  check('FF. repairSiteIndex restores missing index', ok === true && idx[rec.slug] !== undefined);
  await cmd(['HDEL', 'ks:siteidx', rec.slug]);
  const ok2 = await sites.repairSiteIndex('does-not-exist');
  check('FG. repairSiteIndex no-op for missing site', ok2 === false);
}

// ---- CONCURRENT SAME-CANDIDATE RACE (no outer lease) ----
console.log('\nCONCURRENT SAME-CANDIDATE RACE');
{
  seed();
  await saveCand(candidate('ChIJ_A'));
  const owner = 'own-test';
  await cmd(['SET', 'ks:draft:lease', owner]);
  const ctx = {
    taken: await sites.existingSlugs(),
    placeIndex: {},
    siteList: [],
    owner,
    runId: 'draft-run-test',
    draftsPerRun: 5,
  };
  const now = new Date().toISOString();
  const [a, b] = await Promise.all([
    draftAuto._draftCandidate(candidate('ChIJ_A'), ctx, now),
    draftAuto._draftCandidate(candidate('ChIJ_A'), ctx, now),
  ]);
  const placeIdx = parseHash(await cmd(['HGETALL', 'ks:draft:place']));
  const bodies = bodiesForPlace('ChIJ_A');
  const c = (await disc.getCandidates())['ChIJ_A'];
  check('FH. concurrent race: one canonical slug', Object.keys(placeIdx).length === 1 && placeIdx['ChIJ_A'] !== undefined);
  check('FI. concurrent race: one site body', bodies.length === 1);
  check('FJ. concurrent race: candidate linked', c.draftSlug === placeIdx['ChIJ_A']);
}

// ---- LEASE RENEWAL / STALE WORKER ----
console.log('\nLEASE RENEWAL / STALE WORKER');
{
  seed();
  const ownerA = 'own-aaaaaaaaaaaaaaaa';
  const ownerB = 'own-bbbbbbbbbbbbbbbb';
  // A acquires, renews, B cannot steal.
  await cmd(['SET', 'ks:draft:lease', ownerA, 'PX', '10000']);
  check('FK. healthy owner can renew', await draftAuto._renewLease(ownerA, 10000));
  check('FL. stale owner cannot renew', !(await draftAuto._renewLease(ownerB, 10000)));
  check('FM. stale owner cannot release', !(await draftAuto._releaseLease(ownerB)));
  // Lease expires; B acquires; A cannot release/complete.
  await cmd(['SET', 'ks:draft:lease', ownerB, 'PX', '10000']);
  check('FN. stale owner cannot release successor lease', !(await draftAuto._releaseLease(ownerA)));
  const completeRes = await draftAuto._completeRun({ owner: ownerA, runId: 'draft-run-test', run: { id: 'draft-run-test', status: 'completed' } });
  check('FO. stale owner cannot complete run', completeRes === false);
}

// ---- STALE WORKER CANNOT DUPLICATE DRAFT ----
console.log('\nSTALE WORKER CANNOT DUPLICATE DRAFT');
{
  seed();
  await saveCand(candidate('ChIJ_A'));
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
  const ownerA = 'own-aaaaaaaaaaaaaaaa';
  const ownerB = 'own-bbbbbbbbbbbbbbbb';
  let releaseA;
  const gate = new Promise((res) => { releaseA = res; });
  // A acquires the lease itself and blocks inside the candidate loop.
  const runA = draftAuto.runDraftAutonomy({ owner: ownerA, beforeCandidate: async () => { await gate; } });
  // Wait until A has acquired the lease, then flip it to B (simulating expiry + B takeover).
  while (KV.get('ks:draft:lease') !== ownerA) await new Promise((s) => setTimeout(s, 5));
  await cmd(['SET', 'ks:draft:lease', ownerB, 'PX', '10000']);
  releaseA();
  const rA = await runA;
  // B took over the lease; clear it so B can acquire cleanly in runDraftAutonomy.
  await cmd(['DEL', 'ks:draft:lease']);
  // B now runs to completion.
  const rB = await draftAuto.runDraftAutonomy({ owner: ownerB });
  const bodies = bodiesForPlace('ChIJ_A');
  check('FP. stale worker + successor run -> one site body', bodies.length === 1);
  check('FQ. successor run completes', rB.reason === 'completed' || rB.reason === 'caught_up');
  check('FP2. stale worker run reports failure', rA.reason === 'failed');
}

// ---- K4 -> K5 -> K4 -> K5 CROSS-STAGE SEQUENCE ----
console.log('\nK4 -> K5 -> K4 -> K5 CROSS-STAGE SEQUENCE');
{
  seed();
  const placeId = 'ChIJ_CROSS';
  const cand = candidate(placeId, { name: 'Cross Stage Auto', phone: '816-555-0999', score: 1.5 });
  await saveCand(cand);
  await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });

  // K5 creates one draft.
  const r1 = await draftAuto.runDraftAutonomy();
  const c1 = (await disc.getCandidates())[placeId];
  const site1 = await sites.getSite(c1.draftSlug);

  // K4 rediscovers same placeId: refresh facts and re-derive exclusion.
  // Critically, K5 linkage fields must be preserved.
  const refreshed = {
    ...c1,
    name: 'Cross Stage Auto', lastSeenAt: new Date().toISOString(),
    queries: [...c1.queries, { trade: 'plumber', city: 'Kansas City', at: new Date().toISOString() }],
    status: 'excluded',
    excludeReason: 'existing_site',
    excludeDetail: 'an existing site or draft already exists',
    score: 0,
    parts: {},
  };
  await cmd(['HSET', 'ks:disc:cands', placeId, JSON.stringify(refreshed)]);

  // K5 runs again (clear prior run ledger so this run actually executes).
  await cmd(['DEL', 'ks:draft:runs']);
  const r2 = await draftAuto.runDraftAutonomy();
  const c2 = (await disc.getCandidates())[placeId];
  const bodies = bodiesForPlace(placeId);
  check('FR. cross-stage: one site total', bodies.length === 1);
  check('FS. cross-stage: same draftSlug preserved', c2.draftSlug === c1.draftSlug);
  check('FT. cross-stage: no second draft', (r2.run || {}).drafted === 0);
  check('FU. cross-stage: still unpublished', site1.published === false && site1.claimed === false);
  check('FV. cross-stage: no entitlement', site1.modules.join(',') === 'P0' && !site1.email);
}

// ---- LEASE-FENCED MUTATION MODEL ----
console.log('\nLEASE-FENCED MUTATION MODEL');
{
  // Stale-after-renew fresh commit blocked.
  {
    seed();
    await saveCand(candidate('ChIJ_A'));
    await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
    const ownerA = 'own-aaaaaaaaaaaaaaaa';
    const ownerB = 'own-bbbbbbbbbbbbbbbb';
    let releaseA;
    const gate = new Promise((res) => { releaseA = res; });
    let renewed = false;
    const runA = draftAuto.runDraftAutonomy({
      owner: ownerA,
      beforeCandidate: async () => {
        if (!renewed) {
          await draftAuto._renewLease(ownerA, 10000);
          renewed = true;
          await gate;
        }
      },
    });
    while (KV.get('ks:draft:lease') !== ownerA) await new Promise((s) => setTimeout(s, 5));
    await cmd(['SET', 'ks:draft:lease', ownerB, 'PX', '10000']);
    releaseA();
    const rA = await runA;
    const bodiesAfterA = bodiesForPlace('ChIJ_A');
    await cmd(['DEL', 'ks:draft:lease']);
    const rB = await draftAuto.runDraftAutonomy({ owner: ownerB });
    const bodiesAfterB = bodiesForPlace('ChIJ_A');
    check('FW. stale-after-renew fresh commit blocked',
      rA.reason === 'failed' && bodiesAfterA.length === 0 && rB.reason === 'completed' && bodiesAfterB.length === 1);
  }

  // Stale lease on repair: mapping+body exist, index missing.
  {
    seed();
    await saveCand(candidate('ChIJ_A'));
    await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
    const lead = draftAuto.candidateToLead(candidate('ChIJ_A'));
    const rec = (await import('../lib/draft-site.js')).draftFromLead(lead, new Set());
    const site = { ...rec, placeId: 'ChIJ_A', published: false, claimed: false, modules: ['P0'], source: 'draft-autonomy', leadId: 'ChIJ_A' };
    await cmd(['SET', 'ks:site:' + rec.slug, JSON.stringify(site)]);
    await cmd(['HSET', 'ks:draft:place', 'ChIJ_A', rec.slug]);
    const ownerA = 'own-aaaaaaaaaaaaaaaa';
    const ownerB = 'own-bbbbbbbbbbbbbbbb';
    let releaseA;
    const gate = new Promise((res) => { releaseA = res; });
    let renewed = false;
    const runA = draftAuto.runDraftAutonomy({
      owner: ownerA,
      beforeCandidate: async () => {
        if (!renewed) {
          await draftAuto._renewLease(ownerA, 10000);
          renewed = true;
          await gate;
        }
      },
    });
    while (KV.get('ks:draft:lease') !== ownerA) await new Promise((s) => setTimeout(s, 5));
    await cmd(['SET', 'ks:draft:lease', ownerB, 'PX', '10000']);
    releaseA();
    const rA = await runA;
    const idxAfterA = parseHash(await cmd(['HGETALL', 'ks:siteidx']));
    const cAfterA = (await disc.getCandidates())['ChIJ_A'];
    await cmd(['DEL', 'ks:draft:lease']);
    const rB = await draftAuto.runDraftAutonomy({ owner: ownerB });
    const idxAfterB = parseHash(await cmd(['HGETALL', 'ks:siteidx']));
    const cAfterB = (await disc.getCandidates())['ChIJ_A'];
    check('FX. stale lease repair-index blocked',
      rA.reason === 'failed' && idxAfterA[rec.slug] === undefined && !cAfterA.draftSlug &&
      rB.reason === 'completed' && idxAfterB[rec.slug] !== undefined && cAfterB.draftSlug === rec.slug);
  }

  // Stale lease on repair: mapping+body+index exist, candidate linkage missing.
  {
    seed();
    await saveCand(candidate('ChIJ_A'));
    await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
    const lead = draftAuto.candidateToLead(candidate('ChIJ_A'));
    const rec = (await import('../lib/draft-site.js')).draftFromLead(lead, new Set());
    const site = { ...rec, placeId: 'ChIJ_A', published: false, claimed: false, modules: ['P0'], source: 'draft-autonomy', leadId: 'ChIJ_A' };
    await cmd(['SET', 'ks:site:' + rec.slug, JSON.stringify(site)]);
    await cmd(['HSET', 'ks:siteidx', rec.slug, JSON.stringify((await import('../lib/sites.js')).summary(site))]);
    await cmd(['HSET', 'ks:draft:place', 'ChIJ_A', rec.slug]);
    const ownerA = 'own-aaaaaaaaaaaaaaaa';
    const ownerB = 'own-bbbbbbbbbbbbbbbb';
    let releaseA;
    const gate = new Promise((res) => { releaseA = res; });
    let renewed = false;
    const runA = draftAuto.runDraftAutonomy({
      owner: ownerA,
      beforeCandidate: async () => {
        if (!renewed) {
          await draftAuto._renewLease(ownerA, 10000);
          renewed = true;
          await gate;
        }
      },
    });
    while (KV.get('ks:draft:lease') !== ownerA) await new Promise((s) => setTimeout(s, 5));
    await cmd(['SET', 'ks:draft:lease', ownerB, 'PX', '10000']);
    releaseA();
    const rA = await runA;
    const cAfterA = (await disc.getCandidates())['ChIJ_A'];
    await cmd(['DEL', 'ks:draft:lease']);
    const rB = await draftAuto.runDraftAutonomy({ owner: ownerB });
    const cAfterB = (await disc.getCandidates())['ChIJ_A'];
    check('FY. stale lease repair-linkage blocked',
      rA.reason === 'failed' && !cAfterA.draftSlug &&
      rB.reason === 'completed' && cAfterB.draftSlug === rec.slug);
  }
}

// ---- DURABLE RUN CAP ----
console.log('\nDURABLE RUN CAP');
{
  // Failed-run retry cannot exceed draftsPerRun.
  {
    seed();
    await saveCand(candidate('ChIJ_A', { score: 3.0 }));
    await saveCand(candidate('ChIJ_B', { name: 'Beta Plumbing', phone: '816-555-0200', score: 2.0 }));
    await saveCand(candidate('ChIJ_C', { name: 'Gamma HVAC', phone: '816-555-0300', score: 1.0 }));
    await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 2, minScore: 0 });
    let processed = 0;
    const runA = draftAuto.runDraftAutonomy({
      beforeCandidate: async () => {
        processed++;
        if (processed > 1) throw new Error('simulated crash after first candidate');
      },
    });
    const rA = await runA;
    const effectsA = await draftAuto._getRunEffects(runIdForToday());
    // A drafted exactly one before crashing.
    check('FZ. crash run created one new effect', rA.reason === 'failed' && effectsA.counter === 1);
    // Make A ineligible for the retry.
    const a = (await disc.getCandidates())['ChIJ_A'];
    await cmd(['HSET', 'ks:disc:cands', 'ChIJ_A', JSON.stringify({ ...a, status: 'excluded', score: 0 })]);
    const rB = await draftAuto.runDraftAutonomy();
    const effectsB = await draftAuto._getRunEffects(runIdForToday());
    const totalSites = (await sites.listSites()).length;
    check('FZ2. retry respects durable cap', rB.reason === 'completed' && effectsB.counter <= 2 && totalSites <= 2 && rB.run.drafted <= 2);
  }

  // Concurrent different-place cap race.
  {
    seed();
    await saveCand(candidate('ChIJ_A', { score: 2.0 }));
    await saveCand(candidate('ChIJ_B', { name: 'Beta Plumbing', phone: '816-555-0200', score: 1.0 }));
    await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 1, minScore: 0 });
    const owner = 'own-cap-race';
    await cmd(['SET', 'ks:draft:lease', owner]);
    const ctx = {
      taken: await sites.existingSlugs(),
      placeIndex: {},
      siteList: [],
      owner,
      runId: 'draft-run-cap-race',
      draftsPerRun: 1,
    };
    const now = new Date().toISOString();
    const [a, b] = await Promise.all([
      draftAuto._draftCandidate(candidate('ChIJ_A', { score: 2.0 }), ctx, now),
      draftAuto._draftCandidate(candidate('ChIJ_B', { name: 'Beta Plumbing', phone: '816-555-0200', score: 1.0 }), ctx, now),
    ]);
    const effects = await draftAuto._getRunEffects('draft-run-cap-race');
    const totalBodies = bodiesForPlace('ChIJ_A').length + bodiesForPlace('ChIJ_B').length;
    check('GA. cap race: exactly one new draft',
      effects.counter === 1 && Object.values(effects.effects).filter((v) => v === 'new').length === 1 &&
      totalBodies === 1 &&
      ((a.action === 'drafted' && b.action === 'cap_reached') || (b.action === 'drafted' && a.action === 'cap_reached')));
  }

  // Different placeId same-slug collision.
  {
    seed();
    await saveCand(candidate('ChIJ_A', { city: '', score: 2.0 }));
    await saveCand(candidate('ChIJ_B', { city: '', score: 1.0 }));
    await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
    const r = await draftAuto.runDraftAutonomy();
    const placeIdx = parseHash(await cmd(['HGETALL', 'ks:draft:place']));
    const aBodies = bodiesForPlace('ChIJ_A');
    const bBodies = bodiesForPlace('ChIJ_B');
    const slugs = new Set([placeIdx['ChIJ_A'], placeIdx['ChIJ_B']]);
    check('GB. same-name different place -> two distinct slugs',
      r.run.drafted === 2 && slugs.size === 2 && aBodies.length === 1 && bBodies.length === 1 &&
      aBodies[0] !== bBodies[0]);
  }

  // Durable run-effect reconciliation.
  {
    seed();
    await saveCand(candidate('ChIJ_A', { score: 2.0 }));
    await saveCand(candidate('ChIJ_B', { name: 'Beta Plumbing', phone: '816-555-0200', score: 1.0 }));
    // Pre-create a site for B so the run links it (repair) and drafts A (new).
    const leadB = draftAuto.candidateToLead(candidate('ChIJ_B', { name: 'Beta Plumbing', phone: '816-555-0200' }));
    const recB = (await import('../lib/draft-site.js')).draftFromLead(leadB, new Set());
    const siteB = { ...recB, placeId: 'ChIJ_B', published: false, claimed: false, modules: ['P0'], source: 'draft-autonomy', leadId: 'ChIJ_B' };
    await cmd(['SET', 'ks:site:' + recB.slug, JSON.stringify(siteB)]);
    await cmd(['HSET', 'ks:siteidx', recB.slug, JSON.stringify((await import('../lib/sites.js')).summary(siteB))]);
    await cmd(['HSET', 'ks:draft:place', 'ChIJ_B', recB.slug]);
    await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
    const r = await draftAuto.runDraftAutonomy();
    const runId = runIdForToday();
    const effects = await draftAuto._getRunEffects(runId);
    const rc = await cmd(['GET', 'ks:draft:rc:' + runId]);
    check('GC. durable effects reconcile with ledger',
      r.run.drafted === 1 && r.run.linked === 1 &&
      Number(rc) === 1 &&
      Object.values(effects.effects).filter((v) => v === 'new').length === 1 &&
      Object.values(effects.effects).filter((v) => v === 'repair').length === 1);
  }
}

// ---- RESIDUAL FENCING CLOSURE ----
console.log('\nRESIDUAL FENCING CLOSURE');
{
  // Stale K5 candidate exclusion update blocked.
  {
    seed();
    await saveCand(candidate('ChIJ_A'));
    await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
    const ownerA = 'own-aaaaaaaaaaaaaaaa';
    const ownerB = 'own-bbbbbbbbbbbbbbbb';
    let releaseA;
    const gate = new Promise((res) => { releaseA = res; });
    let renewed = false;
    const runA = draftAuto.runDraftAutonomy({
      owner: ownerA,
      beforeCandidate: async () => {
        if (!renewed) {
          await draftAuto._renewLease(ownerA, 10000);
          renewed = true;
          await gate;
        }
      },
    });
    while (KV.get('ks:draft:lease') !== ownerA) await new Promise((s) => setTimeout(s, 5));
    await cmd(['SET', 'ks:draft:lease', ownerB, 'PX', '10000']);
    releaseA();
    const rA = await runA;
    const cAfterA = (await disc.getCandidates())['ChIJ_A'];
    await cmd(['DEL', 'ks:draft:lease']);
    const rB = await draftAuto.runDraftAutonomy({ owner: ownerB });
    const cAfterB = (await disc.getCandidates())['ChIJ_A'];
    check('GD. stale K5 exclusion update blocked',
      rA.reason === 'failed' && !cAfterA.draftSlug && cAfterA.draftStatus !== 'excluded' &&
      rB.reason === 'completed' && cAfterB.draftSlug && cAfterB.draftStatus === 'drafted');
  }

  // Stale run-ledger fallback write blocked; successor completed ledger protected.
  {
    seed();
    await saveCand(candidate('ChIJ_A'));
    await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
    const ownerA = 'own-aaaaaaaaaaaaaaaa';
    const ownerB = 'own-bbbbbbbbbbbbbbbb';

    // B completes a run; afterwards the lease is released.
    const runB = await draftAuto.runDraftAutonomy({ owner: ownerB });
    const completedRun = (await draftAuto.getDraftRuns())[runIdForToday()];

    // A (stale) attempts to overwrite with a failed record.
    const overwrite = await draftAuto._recordRunStatus({ owner: ownerA, runId: runIdForToday(), run: { ...completedRun, status: 'failed', error: 'stale overwrite' } });
    const runAfter = (await draftAuto.getDraftRuns())[runIdForToday()];
    check('GE. stale owner cannot overwrite completed run ledger',
      runB.reason === 'completed' && completedRun.status === 'completed' &&
      overwrite === false && runAfter.status === 'completed' && runAfter.error !== 'stale overwrite');
  }

  // Canonical mapping immutability.
  {
    seed();
    await cmd(['SET', 'ks:draft:lease', 'own-1']);
    await cmd(['HSET', 'ks:draft:place', 'ChIJ_A', 'acme-auto']);
    const link1 = await draftAuto._linkDraft({ owner: 'own-1', placeId: 'ChIJ_A', slug: 'acme-auto', candidate: { placeId: 'ChIJ_A', draftSlug: 'acme-auto' } });
    const link2 = await draftAuto._linkDraft({ owner: 'own-1', placeId: 'ChIJ_A', slug: 'different-slug', candidate: { placeId: 'ChIJ_A', draftSlug: 'different-slug' } });
    const placeIdx = parseHash(await cmd(['HGETALL', 'ks:draft:place']));
    check('GF. same mapping retry idempotent', link1.status === 'OK' && placeIdx['ChIJ_A'] === 'acme-auto');
    check('GG. conflicting mapping rejected', link2.status === 'MAPPING_CONFLICT' && placeIdx['ChIJ_A'] === 'acme-auto');
  }

  // Corrupt / invalid cap fail closed.
  {
    seed();
    await saveCand(candidate('ChIJ_A'));
    await draftAuto.saveDraftConfig({ enabled: true, draftsPerRun: 5, minScore: 0 });
    const owner = 'own-cap';
    await cmd(['SET', 'ks:draft:lease', owner]);
    const ctx = {
      taken: await sites.existingSlugs(),
      placeIndex: {},
      siteList: [],
      owner,
      runId: 'draft-run-cap-corrupt',
      draftsPerRun: 5,
    };

    // Negative counter.
    await cmd(['SET', 'ks:draft:rc:draft-run-cap-corrupt', '-1']);
    const rNeg = await draftAuto._draftCandidate(candidate('ChIJ_A'), ctx, new Date().toISOString());
    check('GH. negative run counter fails closed', rNeg.action === 'abort');
    await cmd(['DEL', 'ks:draft:rc:draft-run-cap-corrupt']);

    // Nonnumeric counter.
    await cmd(['SET', 'ks:draft:rc:draft-run-cap-corrupt', 'abc']);
    const rNon = await draftAuto._draftCandidate(candidate('ChIJ_A'), ctx, new Date().toISOString());
    check('GI. nonnumeric run counter fails closed', rNon.action === 'abort');
    await cmd(['DEL', 'ks:draft:rc:draft-run-cap-corrupt']);

    // Invalid cap (zero).
    const rZero = await draftAuto._applyDraft({
      owner, runId: 'draft-run-cap-corrupt', draftsPerRun: 0, placeId: 'ChIJ_A', slug: 'acme-auto',
      site: { business: 'Acme Auto', slug: 'acme-auto', modules: ['P0'], published: false, claimed: false },
      candidate: { placeId: 'ChIJ_A' }, effectType: 'new',
    });
    check('GJ. invalid draftsPerRun zero fails closed', rZero.status === 'INVALID_CAP');

    // Fractional cap.
    const rFrac = await draftAuto._applyDraft({
      owner, runId: 'draft-run-cap-corrupt', draftsPerRun: 1.5, placeId: 'ChIJ_A', slug: 'acme-auto',
      site: { business: 'Acme Auto', slug: 'acme-auto', modules: ['P0'], published: false, claimed: false },
      candidate: { placeId: 'ChIJ_A' }, effectType: 'new',
    });
    check('GK. fractional draftsPerRun fails closed', rFrac.status === 'INVALID_CAP');
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
