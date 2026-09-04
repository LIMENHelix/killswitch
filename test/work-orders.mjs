// Paid request intake through real support/master handlers over a fake Redis.
// Proves one customer action becomes one durable order and one completion event.
process.env.KV_REST_API_URL = 'https://kv.work.test/';
process.env.KV_REST_API_TOKEN = 'kvtok';
process.env.KS_PANEL_SECRET = 'panel-secret';
process.env.ADMIN_KEY = 'admin-key';
process.env.PUBLIC_SITE_ORIGIN = 'https://killswitchwebsites.com';
delete process.env.RESEND_API_KEY;
delete process.env.VERCEL_ENV;

const KV = new Map();
const sentMail = [];
const sentHeaders = [];
globalThis.fetch = async (url, opts = {}) => {
  const target = String(url);
  if (target === 'https://api.resend.com/emails') {
    sentMail.push(JSON.parse(opts.body));
    sentHeaders.push(opts.headers || {});
    return { ok: true, status: 200, json: async () => ({ id: 'email_1' }), text: async () => '' };
  }
  if (!target.startsWith('https://kv.work.test')) throw new Error('unexpected network: ' + target);
  const input = JSON.parse(opts.body);
  const run = (a) => {
    const [op, key, field, value] = a;
    if (op === 'GET') return KV.has(key) ? KV.get(key) : null;
    if (op === 'SET' && String(a[3]).toUpperCase() === 'NX') { if (KV.has(key)) return null; KV.set(key, field); return 'OK'; }
    if (op === 'SET') { KV.set(key, value === undefined ? field : value); return 'OK'; }
    if (op === 'HGET') return (KV.get(key) || {})[field] ?? null;
    if (op === 'HGETALL') { const out = []; for (const [k, v] of Object.entries(KV.get(key) || {})) out.push(k, v); return out; }
    if (op === 'HSET') { const h = KV.get(key) || {}; h[field] = value; KV.set(key, h); return 1; }
    if (op === 'HSETNX') { const h = KV.get(key) || {}; if (h[field] !== undefined) return 0; h[field] = value; KV.set(key, h); return 1; }
    if (op === 'HDEL') { const h = KV.get(key) || {}; delete h[field]; KV.set(key, h); return 1; }
    if (op === 'INCR') { const n = Number(KV.get(key) || 0) + 1; KV.set(key, String(n)); return n; }
    if (op === 'EXPIRE') return 1;
    throw new Error('unsupported ' + op);
  };
  const result = target.endsWith('/pipeline')
    ? input.map((a) => ({ result: run(a) }))
    : { result: run(input) };
  return { ok: true, status: 200, json: async () => result, text: async () => JSON.stringify(result) };
};

const support = (await import('../api/support.js')).default;
const master = (await import('../api/master.js')).default;
const { upsertAccount } = await import('../lib/store.js');
const { upsertSite } = await import('../lib/sites.js');
const { panelToken } = await import('../lib/panel-auth.js');
const { createWorkOrder, listWorkOrders, getWorkOrder } = await import('../lib/work-orders.js');
const { getLifecycleEvents, getLifecycleState } = await import('../lib/lifecycle.js');

let passed = 0, failed = 0;
function check(name, condition, detail = '') {
  if (condition) { console.log('  PASS  ' + name); passed++; }
  else { console.log('  FAIL  ' + name + (detail ? ' <- ' + detail : '')); failed++; }
}
function mkRes() {
  const r = { code: 0, body: null };
  r.status = (code) => { r.code = code; return r; };
  r.json = (body) => { r.body = body; return r; };
  return r;
}
async function call(handler, body, method = 'POST') {
  const res = mkRes();
  await handler({ method, body, query: {}, headers: { 'x-forwarded-for': '198.51.100.22' } }, res);
  return res;
}

const email = 'care@example.com';
await upsertAccount({ email, name: 'Care Shop', site: 'Care Shop', plan: ['P0'], owned: ['P4'] });
await upsertSite({ business: 'Care Shop', email, published: true, claimed: true, modules: ['P0', 'P4'] });
const token = await panelToken(email);

console.log('\nA PAID CHANGE REQUEST BECOMES ONE DURABLE WORK ORDER');
const payload = {
  e: email, t: token, action: 'submit', requestId: 'work_req_0001',
  requests: ['Change Saturday hours to 9 to 2.', 'Add tire rotation to services.'],
};
const submitted = await call(support, payload);
check('the request is accepted into the queue', submitted.code === 200 && submitted.body.queued, JSON.stringify(submitted.body));
const workId = submitted.body.workOrderId;
check('the browser request id becomes a scoped opaque work order id', /^wo_[a-f0-9]{32}$/.test(workId), workId);
let orders = await listWorkOrders();
check('the complete request survives in durable storage', orders.length === 1 && orders[0].requests.length === 2, JSON.stringify(orders));
check('the order points at the real live site', orders[0].site === '/s/care-shop', orders[0].site);

const replay = await call(support, payload);
check('a network replay is recognized', replay.code === 200 && replay.body.duplicate === true);
check('a replay creates no second order', (await listWorkOrders()).length === 1);

console.log('\nONLY MASTER COMPLETION MOVES THE SERVICE LIFECYCLE');
check('the request is open before fulfillment', (await getWorkOrder(workId)).status === 'open');
check('an invalid owner key cannot list customer work', (await call(master, { token: 'wrong', action: 'work-list' })).code === 401);
const listed = await call(master, { token: 'admin-key', action: 'work-list' });
check('Master sees the exact queued request', listed.code === 200 && listed.body.orders[0].email === email);

process.env.RESEND_API_KEY = 're_test';
const completed = await call(master, {
  token: 'admin-key', action: 'work-complete', id: workId,
  note: 'Saturday hours and tire rotation are live.',
});
check('Master marks the real order complete', completed.code === 200 && completed.body.order.status === 'completed', JSON.stringify(completed.body));
check('the completion note is stored', (await getWorkOrder(workId)).completionNote.includes('Saturday hours'));
check('the customer, not the operator, receives the completion email', sentMail.length === 1 && sentMail[0].to[0] === email, JSON.stringify(sentMail));
check('the provider send has a deterministic idempotency key', sentHeaders[0]['Idempotency-Key'] === 'work-order-complete-' + workId, JSON.stringify(sentHeaders[0]));
check('successful notification is durable', !!(await getWorkOrder(workId)).customerNotifiedAt);
const life = await getLifecycleState(email);
check('completion advances the lifecycle', life.stage === 'service_completed' && life.status === 'active', JSON.stringify(life));
check('the immutable event names the work order', (await getLifecycleEvents(email)).some((e) => e.type === 'service.completed' && e.data.workOrderId === workId));

const completedReplay = await call(master, { token: 'admin-key', action: 'work-complete', id: workId });
check('replaying completion is safe', completedReplay.code === 200 && completedReplay.body.duplicate === true);
check('completion replay sends no second email', sentMail.length === 1);
check('completion replay creates no second lifecycle event', (await getLifecycleEvents(email)).filter((e) => e.type === 'service.completed').length === 1);
check('an unknown work order is not called complete', (await call(master, { token: 'admin-key', action: 'work-complete', id: 'work_missing' })).code === 404);
const other = await createWorkOrder({ id: 'work_req_0001', email: 'other@example.com', requests: ['Different customer'] });
check('the same browser id cannot collide across customers', other.order.id !== workId);

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
