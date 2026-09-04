process.env.KV_REST_API_URL = 'https://kv.lifecycle.test/';
process.env.KV_REST_API_TOKEN = 'token';
delete process.env.VERCEL_ENV;

const KV = new Map();
globalThis.fetch = async (url, opts = {}) => {
  const input = JSON.parse(opts.body);
  const run = (a) => {
    const [op, key, field, value] = a;
    if (op === 'HGET') return (KV.get(key) || {})[field] ?? null;
    if (op === 'HGETALL') {
      const flat = [];
      for (const [k, v] of Object.entries(KV.get(key) || {})) flat.push(k, v);
      return flat;
    }
    if (op === 'HSET') {
      const hash = KV.get(key) || {};
      hash[field] = value;
      KV.set(key, hash);
      return 1;
    }
    throw new Error('unsupported ' + op);
  };
  const result = String(url).endsWith('/pipeline')
    ? input.map((a) => ({ result: run(a) }))
    : { result: run(input) };
  return { ok: true, status: 200, json: async () => result };
};

const {
  recordLifecycle,
  getLifecycleState,
  getLifecycleEvents,
  getLifecycleStates,
  requiredIntegrations,
  reconcileLifecycle,
  backfillLifecycle,
} = await import('../lib/lifecycle.js');

let passed = 0, failed = 0;
function check(name, condition, detail = '') {
  if (condition) { console.log('  PASS  ' + name); passed++; }
  else { console.log('  FAIL  ' + name + (detail ? ' <- ' + detail : '')); failed++; }
}

console.log('\nA CUSTOMER HAS ONE DURABLE, EXPLAINABLE LIFECYCLE');
const email = 'Owner@Example.com';
await recordLifecycle(email, { type: 'lead.received', stage: 'lead_received', idempotencyKey: 'signup:lead' });
await recordLifecycle(email, { type: 'site.published', stage: 'site_published', idempotencyKey: 'signup:site' });
await recordLifecycle(email, { type: 'customer.onboarded', stage: 'onboarded', idempotencyKey: 'signup:onboard' });
await reconcileLifecycle({
  email,
  account: { email: email.toLowerCase(), plan: ['P0'] },
  site: { slug: 'owner-shop', published: true, modules: ['P0'] },
  idempotencyKey: 'signup',
});
let state = await getLifecycleState(email);
check('a free-site customer reaches active automatically', state.stage === 'active' && state.status === 'active', JSON.stringify(state));
check('customer identity is normalized', state.email === 'owner@example.com');

const before = (await getLifecycleEvents(email)).length;
const replay = await recordLifecycle(email, { type: 'site.published', stage: 'site_published', idempotencyKey: 'signup:site' });
check('replaying the same operation is recognized', replay.duplicate === true);
check('replay creates no second business event', (await getLifecycleEvents(email)).length === before);
check('a late lower-stage event cannot move state backwards', (await getLifecycleState(email)).stage === 'active');

console.log('\nPAID MODULES CANNOT LOOK READY WHILE THEIR CONNECTION IS MISSING');
check('Google, booking, and payments name their exact missing connections',
  requiredIntegrations(['P1', 'P3', 'P7'], {}).join(',') === 'google_business_profile,calendar_booking_url,stripe_connect_or_payment_url');
await reconcileLifecycle({
  email,
  account: { plan: ['P0', 'P3'] },
  site: { slug: 'owner-shop', published: true, modules: ['P0', 'P3'] },
  idempotencyKey: 'paid-booking',
});
state = await getLifecycleState(email);
check('the customer is visibly blocked', state.status === 'blocked');
check('the state says which setup is required', state.requiredStage === 'integrations_required' && state.blocker === 'calendar_booking_url', JSON.stringify(state));

await reconcileLifecycle({
  email,
  account: { plan: ['P0', 'P3'] },
  site: { slug: 'owner-shop', published: true, modules: ['P0', 'P3'], bookingUrl: 'https://booking.example' },
  idempotencyKey: 'paid-booking-ready',
});
state = await getLifecycleState(email);
check('adding the real connection clears the blocker', state.status === 'active' && state.blocker === '');

console.log('\nFAILURES STAY VISIBLE AND HISTORY STAYS IMMUTABLE');
await recordLifecycle(email, { type: 'payment.failed', blocked: true, blocker: 'payment_failed', idempotencyKey: 'invoice:1' });
state = await getLifecycleState(email);
check('a payment failure blocks the lifecycle without deleting its stage', state.status === 'blocked' && state.stage === 'active');
await recordLifecycle(email, { type: 'service.completed', stage: 'service_completed', blocked: false, idempotencyKey: 'job:1' });
await recordLifecycle(email, { type: 'customer.activated', stage: 'active', idempotencyKey: 'late-active' });
state = await getLifecycleState(email);
check('completion cannot be undone by an out-of-order activation', state.stage === 'service_completed');
check('every distinct business event remains available', (await getLifecycleEvents(email)).length >= 8);
check('all current states can be loaded in one hash read', !!(await getLifecycleStates())['owner@example.com']);

console.log('\nOLD CUSTOMERS ARE SEEDED IN BOUNDED BATCHES');
const accounts = {
  old: { email: 'old@example.com', plan: ['P0'] },
  owner: { email: 'owner@example.com', plan: ['P0'] },
};
const backfill = await backfillLifecycle({
  accounts,
  sites: [{ email: 'old@example.com', slug: 'old-shop', published: true, modules: ['P0'] }],
  limit: 1,
});
check('only a missing lifecycle is seeded', backfill.seeded === 1 && backfill.remaining === 0, JSON.stringify(backfill));
check('the old live customer becomes active', (await getLifecycleState('old@example.com')).stage === 'active');

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
