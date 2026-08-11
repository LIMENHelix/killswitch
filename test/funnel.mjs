// The board is now a funnel. These prove the events the optimizer eats are real:
// losses are recorded as well as wins, the two observable transitions fire on
// their own, and the old four-value vocabulary survives the move.
process.env.KV_REST_API_URL = 'https://kv.test/';
process.env.KV_REST_API_TOKEN = 'kvtok';

const KV = new Map();
globalThis.fetch = async (url, opts = {}) => {
  const json = (o) => ({ ok: true, status: 200, json: async () => o });
  const args = JSON.parse(opts.body);
  const run = (a) => {
    const [c, k, f, v] = a;
    if (c === 'GET') return KV.has(k) ? KV.get(k) : null;
    if (c === 'SET') { KV.set(k, v === undefined ? f : v); return 'OK'; }
    if (c === 'HSET') { const h = KV.get(k) || {}; h[f] = v; KV.set(k, h); return 1; }
    if (c === 'HGET') { const h = KV.get(k) || {}; return h[f] == null ? null : h[f]; }
    if (c === 'HGETALL') { const h = KV.get(k) || {}; const o = []; for (const [a1, b1] of Object.entries(h)) o.push(a1, b1); return o; }
    throw new Error('kv ' + c);
  };
  if (String(url).endsWith('/pipeline')) return json(args.map((a) => ({ result: run(a) })));
  return json({ result: run(args) });
};

const F = await import('../lib/funnel.js');
const { wilsonLower, allocate } = await import('../lib/laser.js');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };

console.log('\nThe board is a funnel now');

// --- the old vocabulary survives ---
check('won becomes an enrollment', F.migrateStage('won') === 'enrollment');
check('responded becomes an appointment', F.migrateStage('responded') === 'appointment');
check('called is still just a lead, not a win', F.migrateStage('called') === 'lead');
check('dead stays dead', F.migrateStage('dead') === 'dead');
check('an unknown value fails safe to lead', F.migrateStage('banana') === 'lead');

// --- the real postage cost came across, not the engine's default ---
check('a postcard costs 94c here, not the engine default 60c', F.CHANNELS.mailer === 94, String(F.CHANNELS.mailer));

// --- LOSSES ARE RECORDED. This is the one that keeps the rates honest. ---
await F.recordTouch('A', { transition: 'leads>appointments', channel: 'call', won: false });
await F.recordTouch('A', { transition: 'leads>appointments', channel: 'call', won: false });
await F.recordTouch('B', { transition: 'leads>appointments', channel: 'call', won: true });
let f = await F.getFunnel();
let plays = F.toPlays(f);
const callPlay = plays.find((p) => p.unit === 'call');
check('a failed call is still a trial', callPlay.trials === 3, JSON.stringify(callPlay));
check('and only the win counts as a win', callPlay.wins === 1, String(callPlay.wins));
check('so the rate is 1 in 3, not 1 in 1', callPlay.wins / callPlay.trials === 1 / 3);

// --- a show records itself ---
await F.setStage('C', 'appointment', { channel: 'mailer' });
await F.recordShow('C');
check('opening their site advances them to show', (await F.getOne('C')).stage === 'show');
await F.recordShow('C');
check('refreshing the page does not re-win the transition',
  (await F.getOne('C')).touches.filter((t) => t.transition === 'appointments>shows').length === 1);

// --- an enrollment records itself, free site = $0 deal ---
await F.recordEnrollment('C', 0);
const c = await F.getOne('C');
check('taking the free site is an enrollment', c.stage === 'enrollment');
check('at a zero deal size, as the operator described won', c.dealCents === 0);
check('and it is a real transition the engine can score',
  c.touches.some((t) => t.transition === 'shows>enrollments' && t.won));

// --- deal size segments a free site away from a paid one ---
check('free and paid are different segments',
  F.dealBucket(0) === 'free' && F.dealBucket(9900) === 'large' && F.dealBucket(1900) === 'small');

// --- and the whole thing feeds laser.js ---
f = await F.getFunnel();
plays = F.toPlays(f);
check('plays carry everything the engine needs',
  plays.every((p) => p.id && p.transitionId && p.unit && p.segment && Number.isFinite(p.trials)));
const w = allocate(plays);
check('the optimizer can allocate over them', Object.keys(w).length > 0, JSON.stringify(w).slice(0, 120));
check('a channel with only losses still scores, at zero',
  wilsonLower(0, 5) === 0 || wilsonLower(0, 5) < wilsonLower(1, 5));

const sum = F.summarize(f);
check('the summary counts stages and real spend',
  sum.byStage.enrollment === 1 && sum.touches > 0 && Number.isFinite(sum.spendCents),
  JSON.stringify(sum.byStage));
check('conversion is reported per transition', !!sum.rates['leads>appointments'], JSON.stringify(sum.rates));

// --- migrating the old board does not double-count ---
KV.delete('ks:funnel');
const before = await F.migrateFrom({ X: { stage: 'won' }, Y: { stage: 'called' }, Z: { stage: 'responded' } });
check('only leads with real history migrate', before.migrated === 2, JSON.stringify(before));
const again = await F.migrateFrom({ X: { stage: 'won' }, Y: { stage: 'called' }, Z: { stage: 'responded' } });
check('running migration twice changes nothing', again.migrated === 0, JSON.stringify(again));

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
