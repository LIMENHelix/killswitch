// Shared in-memory KV stub for K6 outreach tests.
// Sets up globalThis.fetch to impersonate Upstash REST, including the EVAL
// scripts used by lib/outreach-effects.js.

export function setupKvStub() {
  const KV = new Map();
  const EXP = new Map();

  const live = (key) => {
    if (EXP.has(key) && EXP.get(key) <= Date.now()) {
      EXP.delete(key);
      KV.delete(key);
    }
  };

  const get = (key) => { live(key); return KV.has(key) ? KV.get(key) : null; };
  const set = (key, value) => { KV.set(key, value); };

  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (!u.startsWith(process.env.KV_REST_API_URL)) {
      throw new Error('unexpected fetch ' + u);
    }
    const args = JSON.parse(options.body);
    if (u.endsWith('/pipeline')) {
      return { ok: true, status: 200, json: async () => args.map((a) => ({ result: run(a) })) };
    }
    return { ok: true, status: 200, json: async () => ({ result: run(args) }) };
  };

  function run(a) {
    const [cmd, key, f, v] = a;
    if (cmd === 'GET') return get(key);
    if (cmd === 'SET' && a[3] === 'NX' && a[4] === 'PX') {
      live(key);
      if (KV.has(key)) return null;
      set(key, a[2]);
      EXP.set(key, Date.now() + Number(a[5]));
      return 'OK';
    }
    if (cmd === 'SET' && a[3] === 'NX') {
      live(key);
      if (KV.has(key)) return null;
      set(key, f);
      return 'OK';
    }
    if (cmd === 'SET') {
      // SET key value [PX ms|EX s] — flags may follow the value in either
      // position used by this repo's callers.
      let value = f;
      let idx = 3;
      if (a[3] === 'PX' || a[3] === 'EX') { value = f; idx = 4; }
      else if (a[4] === 'PX' || a[4] === 'EX') { value = v; idx = 5; }
      set(key, value);
      if (idx === 4) EXP.set(key, Date.now() + (a[3] === 'EX' ? Number(a[4]) * 1000 : Number(a[4])));
      if (idx === 5) EXP.set(key, Date.now() + (a[4] === 'EX' ? Number(a[5]) * 1000 : Number(a[5])));
      return 'OK';
    }
    if (cmd === 'HSET') {
      const h = get(key) || {};
      h[f] = v;
      set(key, h);
      return 1;
    }
    if (cmd === 'HGET') {
      const h = get(key) || {};
      return h[f] == null ? null : h[f];
    }
    if (cmd === 'HGETALL') {
      const h = get(key) || {};
      const flat = [];
      for (const [k, val] of Object.entries(h)) flat.push(k, val);
      return flat;
    }
    if (cmd === 'HDEL') {
      const h = get(key) || {};
      delete h[f];
      set(key, h);
      return 1;
    }
    if (cmd === 'INCR') {
      const n = Number(get(key) || 0) + 1;
      set(key, String(n));
      return n;
    }
    if (cmd === 'INCRBY') {
      const n = Number(get(key) || 0) + Number(f);
      set(key, String(n));
      return n;
    }
    if (cmd === 'DEL') { KV.delete(key); EXP.delete(key); return 1; }
    if (cmd === 'EVAL') return evalScript(a);
    throw new Error('unexpected kv cmd ' + cmd);
  }

  function evalScript(a) {
    const script = a[1];
    const n = Number(a[2]);
    const keys = a.slice(3, 3 + n);
    const argv = a.slice(3 + n);

    if (script.includes('outreach_reserve_v1')) {
      const [owner, effectId, effectJSON, runId, day, canonicalId, perRunCap, dailyCap, lifetimeCap, perRunSpendCap, dailySpendCap, costCents] = argv;
      if (get(keys[0]) !== owner) return 'LEASE_LOST';
      const checkInt = (s) => {
        const num = Number(s);
        return Number.isFinite(num) && num === Math.floor(num) && num > 0;
      };
      if (!checkInt(perRunCap) || !checkInt(dailyCap) || !checkInt(lifetimeCap) || !checkInt(perRunSpendCap) || !checkInt(dailySpendCap)) return 'INVALID_CAP';
      const effects = get(keys[1]) || {};
      if (effects[effectId] !== undefined) return ['EXISTS', effects[effectId]];
      const checkCounter = (k) => {
        const raw = get(k);
        if (raw == null) return 0;
        const num = Number(raw);
        if (!Number.isFinite(num) || num !== Math.floor(num) || num < 0) return 'CORRUPT';
        return num;
      };
      const rc = checkCounter(keys[2]); if (rc === 'CORRUPT') return 'CORRUPT_COUNTER';
      const dc = checkCounter(keys[3]); if (dc === 'CORRUPT') return 'CORRUPT_COUNTER';
      const lc = checkCounter(keys[4]); if (lc === 'CORRUPT') return 'CORRUPT_COUNTER';
      const rsc = checkCounter(keys[5]); if (rsc === 'CORRUPT') return 'CORRUPT_COUNTER';
      const dsc = checkCounter(keys[6]); if (dsc === 'CORRUPT') return 'CORRUPT_COUNTER';
      const cost = Number(costCents) || 0;
      if (rc >= Number(perRunCap)) return 'RUN_CAP_REACHED';
      if (dc >= Number(dailyCap)) return 'DAILY_CAP_REACHED';
      if (lc >= Number(lifetimeCap)) return 'LIFETIME_CAP_REACHED';
      if (rsc + cost > Number(perRunSpendCap)) return 'RUN_SPEND_CAP_REACHED';
      if (dsc + cost > Number(dailySpendCap)) return 'DAILY_SPEND_CAP_REACHED';
      set(keys[2], String(rc + 1));
      set(keys[3], String(dc + 1));
      set(keys[4], String(lc + 1));
      if (cost > 0) {
        set(keys[5], String(rsc + cost));
        set(keys[6], String(dsc + cost));
      }
      effects[effectId] = effectJSON;
      set(keys[1], effects);
      return ['OK', effectId];
    }

    if (script.includes('outreach_update_v1')) {
      const [owner, effectId, patchJSON] = argv;
      if (get(keys[0]) !== owner) return 'LEASE_LOST';
      const effects = get(keys[1]) || {};
      const cur = effects[effectId];
      if (cur !== undefined) {
        // Mirror the production Lua: structural parse, top-level status only.
        // Never a regex/first-textual match — embedded lead snapshots may
        // carry their own status field. Fail closed with zero mutation.
        let parsed;
        try { parsed = JSON.parse(cur); } catch { return 'CORRUPT_EFFECT'; }
        if (!parsed || typeof parsed !== 'object' || typeof parsed.status !== 'string') return 'CORRUPT_EFFECT';
        const VALID = ['reserved', 'attempting', 'accepted', 'retryable', 'unknown', 'dead', 'rejected'];
        if (!VALID.includes(parsed.status)) return 'CORRUPT_EFFECT';
        if (['accepted', 'dead', 'rejected'].includes(parsed.status)) return 'TERMINAL_LOCKED';
      }
      effects[effectId] = patchJSON;
      set(keys[1], effects);
      return 'OK';
    }

    if (script.includes('outreach_complete_v1')) {
      const [owner, runId, runJSON] = argv;
      if (get(keys[0]) !== owner) return 'LEASE_LOST';
      const runs = get(keys[1]) || {};
      runs[runId] = runJSON;
      set(keys[1], runs);
      return 'OK';
    }

    // lease renewal: GET == owner -> PSETEX
    if (script.includes('PSETEX')) {
      if (get(keys[0]) === argv[0]) {
        set(keys[0], argv[0]);
        EXP.set(keys[0], Date.now() + Number(argv[1]));
        return 'OK';
      }
      return 'LOST';
    }

    // lease release: GET == owner -> DEL
    if (script.includes('DEL') && !script.includes('outreach_')) {
      if (get(keys[0]) === argv[0]) {
        KV.delete(keys[0]);
        EXP.delete(keys[0]);
        return 1;
      }
      return 0;
    }

    throw new Error('unexpected EVAL script ' + script.slice(0, 40));
  }

  return { KV, EXP };
}

export function clearKvStub() {
  globalThis.fetch = undefined;
}
