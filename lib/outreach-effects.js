// K6 — durable outbound-effect ledger with atomic cap reservation.
//
// Every logical outreach action (postcard, email, etc.) gets one durable effect
// record. The record is created atomically with cap reservations so concurrent
// workers, retries, and crashes cannot double-spend capacity or the provider.

import crypto from 'node:crypto';
import { cmd, parseHash, keyFor } from './kv.js';

const EFFECTS_KEY = 'ks:outreach:effects';       // hash: effectId -> effect JSON
const RUNS_KEY = 'ks:outreach:runs';             // hash: runId -> run JSON
const LEASE_KEY = 'ks:outreach:lease';           // string: owner token
const LEASE_TTL_MS = 120000;

const rcKey = (runId) => `ks:outreach:rc:${runId}`;
const dcKey = (utcDay) => `ks:outreach:dc:${utcDay}`;
const lcKey = (canonicalId) => `ks:outreach:lc:${canonicalId}`;

export const STATUS = {
  RESERVED: 'reserved',
  ATTEMPTING: 'attempting',
  ACCEPTED: 'accepted',
  RETRYABLE: 'retryable',
  UNKNOWN: 'unknown',
  DEAD: 'dead',
  REJECTED: 'rejected',
};

const clean = (v, n = 200) => String(v == null ? '' : v).trim().slice(0, n);
const utcDay = (d) => d.toISOString().slice(0, 10);

async function evalKeys(script, keys, args) {
  const scoped = keys.map((k) => keyFor(k));
  return cmd(['EVAL', script, String(scoped.length), ...scoped, ...args.map((a) => String(a))]);
}

const RESERVE_SCRIPT = `
-- outreach_reserve_v1
-- KEYS: 1=lease, 2=effects hash, 3=run counter, 4=daily counter, 5=lifetime counter,
--       6=run spend counter, 7=daily spend counter
-- ARGV: 1=owner, 2=effectId, 3=effectJSON, 4=runId, 5=utcDay, 6=canonicalId,
--       7=perRunCap, 8=dailyCap, 9=lifetimeCap, 10=perRunSpendCap, 11=dailySpendCap, 12=costCents
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 'LEASE_LOST' end
local perRun = tonumber(ARGV[7])
local daily = tonumber(ARGV[8])
local lifetime = tonumber(ARGV[9])
local perRunSpend = tonumber(ARGV[10])
local dailySpend = tonumber(ARGV[11])
local cost = tonumber(ARGV[12]) or 0
if not perRun or perRun ~= math.floor(perRun) or perRun <= 0 then return 'INVALID_CAP' end
if not daily or daily ~= math.floor(daily) or daily <= 0 then return 'INVALID_CAP' end
if not lifetime or lifetime ~= math.floor(lifetime) or lifetime <= 0 then return 'INVALID_CAP' end
if not perRunSpend or perRunSpend ~= math.floor(perRunSpend) or perRunSpend <= 0 then return 'INVALID_CAP' end
if not dailySpend or dailySpend ~= math.floor(dailySpend) or dailySpend <= 0 then return 'INVALID_CAP' end
local existing = redis.call('HGET', KEYS[2], ARGV[2])
if existing then return {'EXISTS', existing} end
local rcRaw = redis.call('GET', KEYS[3])
if rcRaw then
  local rc = tonumber(rcRaw)
  if not rc or rc ~= math.floor(rc) or rc < 0 then return 'CORRUPT_COUNTER' end
  if rc >= perRun then return 'RUN_CAP_REACHED' end
end
local dcRaw = redis.call('GET', KEYS[4])
if dcRaw then
  local dc = tonumber(dcRaw)
  if not dc or dc ~= math.floor(dc) or dc < 0 then return 'CORRUPT_COUNTER' end
  if dc >= daily then return 'DAILY_CAP_REACHED' end
end
local lcRaw = redis.call('GET', KEYS[5])
if lcRaw then
  local lc = tonumber(lcRaw)
  if not lc or lc ~= math.floor(lc) or lc < 0 then return 'CORRUPT_COUNTER' end
  if lc >= lifetime then return 'LIFETIME_CAP_REACHED' end
end
local rsRaw = redis.call('GET', KEYS[6])
if rsRaw then
  local rs = tonumber(rsRaw)
  if not rs or rs ~= math.floor(rs) or rs < 0 then return 'CORRUPT_COUNTER' end
  if rs + cost > perRunSpend then return 'RUN_SPEND_CAP_REACHED' end
end
local dsRaw = redis.call('GET', KEYS[7])
if dsRaw then
  local ds = tonumber(dsRaw)
  if not ds or ds ~= math.floor(ds) or ds < 0 then return 'CORRUPT_COUNTER' end
  if ds + cost > dailySpend then return 'DAILY_SPEND_CAP_REACHED' end
end
redis.call('INCR', KEYS[3])
redis.call('INCR', KEYS[4])
redis.call('INCR', KEYS[5])
if cost > 0 then
  redis.call('INCRBY', KEYS[6], cost)
  redis.call('INCRBY', KEYS[7], cost)
end
redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
return {'OK', ARGV[2]}`;

const UPDATE_SCRIPT = `
-- outreach_update_v1
-- KEYS: 1=lease, 2=effects hash
-- ARGV: 1=owner, 2=effectId, 3=patchJSON
-- Terminal states (accepted/dead/rejected) are locked: a concurrent or stale
-- writer must not resurrect a finished effect. Rewriting the SAME terminal
-- status stays idempotent.
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 'LEASE_LOST' end
local cur = redis.call('HGET', KEYS[2], ARGV[2])
if cur then
  local cs = string.match(cur, '"status":"(%a+)"')
  local ns = string.match(ARGV[3], '"status":"(%a+)"')
  if cs ~= ns and (cs == 'accepted' or cs == 'dead' or cs == 'rejected') then
    return 'TERMINAL_LOCKED'
  end
end
redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
return 'OK'`;

const COMPLETE_SCRIPT = `
-- outreach_complete_v1
-- KEYS: 1=lease, 2=runs hash
-- ARGV: 1=owner, 2=runId, 3=runJSON
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 'LEASE_LOST' end
redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
return 'OK'`;

function parseReserve(res) {
  if (res === 'LEASE_LOST') return { ok: false, status: 'LEASE_LOST' };
  if (res === 'INVALID_CAP') return { ok: false, status: 'INVALID_CAP' };
  if (res === 'CORRUPT_COUNTER') return { ok: false, status: 'CORRUPT_COUNTER' };
  if (res === 'RUN_CAP_REACHED') return { ok: false, status: 'RUN_CAP_REACHED' };
  if (res === 'DAILY_CAP_REACHED') return { ok: false, status: 'DAILY_CAP_REACHED' };
  if (res === 'LIFETIME_CAP_REACHED') return { ok: false, status: 'LIFETIME_CAP_REACHED' };
  if (res === 'RUN_SPEND_CAP_REACHED') return { ok: false, status: 'RUN_SPEND_CAP_REACHED' };
  if (res === 'DAILY_SPEND_CAP_REACHED') return { ok: false, status: 'DAILY_SPEND_CAP_REACHED' };
  if (Array.isArray(res) && res[0] === 'EXISTS') {
    try { return { ok: true, status: 'EXISTS', effect: JSON.parse(res[1]) }; }
    catch { return { ok: true, status: 'EXISTS' }; }
  }
  if (Array.isArray(res) && res[0] === 'OK') return { ok: true, status: 'OK', effectId: res[1] };
  return { ok: false, status: 'UNEXPECTED' };
}

export function makeEffectId({ runId, channel, canonicalId, leadId }) {
  const base = [runId, channel, canonicalId || leadId || 'unknown'].join('|');
  return 'oe-' + crypto.createHash('sha256').update(base).digest('hex').slice(0, 32);
}

export function makeIdempotencyKey({ effectId, attempt = 0 }) {
  return `${effectId}:${attempt}`;
}

export async function acquireLease(owner, ttlMs = LEASE_TTL_MS) {
  const v = await cmd(['SET', LEASE_KEY, owner, 'NX', 'PX', ttlMs]);
  return v === 'OK';
}

export async function renewLease(owner, ttlMs = LEASE_TTL_MS) {
  const script = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PSETEX', KEYS[1], ARGV[2], ARGV[1]) else return 'LOST' end`;
  const v = await evalKeys(script, [LEASE_KEY], [owner, ttlMs]);
  return v === 'OK';
}

export async function checkLease(owner) {
  const v = await cmd(['GET', LEASE_KEY]);
  return v === owner;
}

export async function releaseLease(owner) {
  const script = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
  const v = await evalKeys(script, [LEASE_KEY], [owner]);
  return v === 1 || v === '1';
}

/**
 * Atomically reserve capacity and write the initial effect record.
 *
 * effect must include at minimum: runId, channel, provider, canonicalId,
 * leadId, idempotencyKey, eligibility (object), createdAt.
 */
const rscKey = (runId) => `ks:outreach:rsc:${runId}`;
const dscKey = (utcDay) => `ks:outreach:dsc:${utcDay}`;

export async function reserveEffect({ owner, effect, cfg, costCents = 0 }) {
  const effectId = effect.effectId || makeEffectId(effect);
  const runId = clean(effect.runId);
  const canonicalId = clean(effect.canonicalId) || 'unknown';
  const day = utcDay(new Date(effect.createdAt || Date.now()));

  const perRunCap = Math.max(0, Math.floor(Number(cfg.perRunCap) || 0));
  const dailyCap = Math.max(0, Math.floor(Number(cfg.dailyCap) || 0));
  const lifetimeCap = Math.max(0, Math.floor(Number(cfg.lifetimeCap) || 0));
  const perRunSpendCap = Math.max(0, Math.floor(Number(cfg.perRunSpendCap) || 0));
  const dailySpendCap = Math.max(0, Math.floor(Number(cfg.dailySpendCap) || 0));

  const fullEffect = {
    ...effect,
    effectId,
    status: STATUS.RESERVED,
    attempts: 0,
    costReserved: Math.max(0, Math.floor(costCents)),
    updatedAt: new Date().toISOString(),
  };

  const res = await evalKeys(RESERVE_SCRIPT,
    [LEASE_KEY, EFFECTS_KEY, rcKey(runId), dcKey(day), lcKey(canonicalId), rscKey(runId), dscKey(day)],
    [owner, effectId, JSON.stringify(fullEffect), runId, day, canonicalId, perRunCap, dailyCap, lifetimeCap, perRunSpendCap, dailySpendCap, Math.max(0, Math.floor(costCents))]);

  const parsed = parseReserve(res);
  if (parsed.ok && parsed.status === 'OK') return { ok: true, status: 'OK', effectId, effect: fullEffect };
  if (parsed.ok && parsed.status === 'EXISTS') return { ok: true, status: 'EXISTS', effectId, exists: true, effect: parsed.effect };
  return { ok: false, status: parsed.status, effectId };
}

export async function getEffect(effectId) {
  const raw = await cmd(['HGET', EFFECTS_KEY, effectId]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function getRunEffects(runId) {
  const day = utcDay(new Date());
  const [effectsRaw, rc, dc, rsc, dsc] = await Promise.all([
    cmd(['HGETALL', EFFECTS_KEY]),
    cmd(['GET', rcKey(runId)]),
    cmd(['GET', dcKey(day)]),
    cmd(['GET', rscKey(runId)]),
    cmd(['GET', dscKey(day)]),
  ]);
  const effects = parseHash(effectsRaw);
  const runEffects = Object.values(effects).filter((e) => e && e.runId === runId);
  return { effects: runEffects, rc: Number(rc || 0), dc: Number(dc || 0), rsc: Number(rsc || 0), dsc: Number(dsc || 0) };
}

export async function updateEffect({ owner, effectId, patch }) {
  const cur = await getEffect(effectId);
  if (!cur) return { ok: false, status: 'NOT_FOUND' };
  const next = { ...cur, ...patch, effectId, updatedAt: new Date().toISOString() };
  const res = await evalKeys(UPDATE_SCRIPT, [LEASE_KEY, EFFECTS_KEY], [owner, effectId, JSON.stringify(next)]);
  if (res === 'LEASE_LOST') return { ok: false, status: 'LEASE_LOST' };
  if (res === 'TERMINAL_LOCKED') return { ok: false, status: 'TERMINAL_LOCKED' };
  return { ok: true, effect: next };
}

const PENDING_STATUSES = [STATUS.RESERVED, STATUS.ATTEMPTING, STATUS.RETRYABLE, STATUS.UNKNOWN];

/** All effects still owed a provider outcome, oldest first, optionally per channel. */
export async function listPendingEffects(channel) {
  const raw = parseHash(await cmd(['HGETALL', EFFECTS_KEY]));
  return Object.values(raw)
    .filter((e) => e && PENDING_STATUSES.includes(e.status) && (!channel || e.channel === channel))
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

export async function recordRun({ owner, runId, run }) {
  const res = await evalKeys(COMPLETE_SCRIPT, [LEASE_KEY, RUNS_KEY], [owner, runId, JSON.stringify(run)]);
  return res === 'OK';
}

export async function getRun(runId) {
  const raw = await cmd(['HGET', RUNS_KEY, runId]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function listRuns(limit = 10) {
  const raw = parseHash(await cmd(['HGETALL', RUNS_KEY]));
  return Object.values(raw)
    .sort((a, b) => String(b.id || '').localeCompare(String(a.id || '')))
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));
}

export async function getStatusCounts() {
  const raw = parseHash(await cmd(['HGETALL', EFFECTS_KEY]));
  const counts = {};
  for (const e of Object.values(raw)) {
    if (!e || !e.status) continue;
    counts[e.status] = (counts[e.status] || 0) + 1;
  }
  return counts;
}

export async function listEffects(limit = 50) {
  const raw = parseHash(await cmd(['HGETALL', EFFECTS_KEY]));
  return Object.values(raw)
    .filter((e) => e && e.updatedAt)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
}
