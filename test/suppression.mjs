// One opt-out must stop every outbound path, not only the channel on which it
// arrived. Exercises the real admin, mailer and outreach-writer handlers.
process.env.KV_REST_API_URL = 'https://kv.suppression.test';
process.env.KV_REST_API_TOKEN = 'kvtok';
process.env.ADMIN_KEY = 'owner-key';
process.env.SWITCH_TOKEN = 'switch-key';
process.env.REP_KEYS = 'dana:rep-key';
process.env.ANTHROPIC_API_KEY = 'ant-key';
process.env.LOB_API_KEY = 'lob-key';
process.env.KS_FROM_NAME = 'Sunflower Websites';
process.env.KS_FROM_LINE1 = '1 Main St';
process.env.KS_FROM_CITY = 'Kansas City';
process.env.KS_FROM_STATE = 'MO';
process.env.KS_FROM_ZIP = '64101';
delete process.env.RESEND_API_KEY;
delete process.env.VERCEL_ENV;

import { setupKvStub } from './helpers/k6-kv.mjs';

const { KV } = setupKvStub();
let lobCalls = 0;
let anthropicCalls = 0;

const kvFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const target = String(url);
  const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  if (target === 'https://api.lob.com/v1/postcards') { lobCalls++; return ok({ id: 'psc_' + lobCalls }); }
  if (target === 'https://api.anthropic.com/v1/messages') { anthropicCalls++; throw new Error('suppressed contact reached Anthropic'); }
  return kvFetch(url, opts);
};

const admin = (await import('../api/admin.js')).default;
const switchBrain = (await import('../api/switch-brain.js')).default;
const {
  getSuppression, listSuppressions, suppressContact, liftSuppression,
} = await import('../lib/suppression.js');

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
async function call(handler, body) {
  const res = mkRes();
  await handler({ method: 'POST', body, headers: { host: 'test.local' }, query: {} }, res);
  return res;
}

const lead = {
  id: 'lead-1', name: 'Quiet Plumbing', email: 'Owner@Quiet.example', phone: '(913) 555-0123',
  trade: 'plumber', street: '42 Oak Road', city: 'Lenexa', state: 'KS', zip: '66215',
};
KV.set('ks:leads', JSON.stringify([lead]));

console.log('\nONE DECISION MATCHES EMAIL, PHONE, ADDRESS, AND LEAD ID');
const direct = await suppressContact(lead, { reason: 'Asked us to stop by email', actor: 'dana', source: 'email' });
check('a suppression record is durable', direct.active === true && /^sup_[a-f0-9]{32}$/.test(direct.id));
check('the same email matches regardless of case', !!await getSuppression({ email: 'owner@quiet.example' }));
check('the same phone matches regardless of punctuation', !!await getSuppression({ phone: '913.555.0123' }));
check('the same postal destination blocks a postcard', !!await getSuppression({ street: '42 Oak Road', city: 'Lenexa', state: 'ks', zip: '66215' }));
check('an unrelated contact remains available', !(await getSuppression({ email: 'new@example.com', phone: '8165559999' })));
await liftSuppression(direct.id, 'operator');

console.log('\nA REP CAN HONOR STOP, BUT ONLY THE OWNER CAN REOPEN');
let r = await call(admin, { action: 'suppress', token: 'rep-key', id: lead.id, reason: 'Customer replied STOP', channel: 'text' });
check('a rep can suppress immediately', r.code === 200 && r.body.suppression.active, JSON.stringify(r.body));
const suppressionId = r.body.suppression.id;
r = await call(admin, { action: 'list', token: 'rep-key' });
check('the shared board marks the contact suppressed', r.body.leads[0].suppressed === true && r.body.leads[0].suppressionId === suppressionId);
check('the reason is visible to every operator', r.body.leads[0].suppressionReason === 'Customer replied STOP');
r = await call(admin, { action: 'update', token: 'rep-key', id: lead.id, stage: 'won' });
check('a suppressed lead cannot be silently reopened', r.code === 409 && r.body.error === 'contact_suppressed');
r = await call(admin, { action: 'site-publish', token: 'rep-key', id: lead.id });
check('a suppressed lead cannot receive a freshly published outreach site', r.code === 409 && r.body.error === 'contact_suppressed');
r = await call(admin, { action: 'unsuppress', token: 'rep-key', id: lead.id, suppressionId });
check('a rep cannot lift the owner-controlled safety record', r.code === 403);
r = await call(admin, { action: 'suppression-list', token: 'owner-key' });
check('the owner has a real suppression list', r.code === 200 && r.body.suppressions.length === 1);

console.log('\nEVERY OUTBOUND PATH STOPS BEFORE SPEND OR GENERATION');
r = await call(admin, { action: 'mail', token: 'owner-key', ids: [lead.id] });
check('manual prospect mail fails closed while K6 is unarmed', r.code === 409 && r.body.error === 'outreach_not_armed', JSON.stringify(r.body));
check('unarmed means Lob is never called', lobCalls === 0);
r = await call(admin, { action: 'outreach-setconfig', token: 'owner-key', enabled: true, mode: 'test', channels: ['postcard'], perRunCap: 5, dailyCap: 5, lifetimeCap: 5, perRunSpendCap: 500, dailySpendCap: 500, postcardReserveCents: 94 });
check('the owner can arm a complete synthetic K6 config', r.code === 200 && r.body.config.enabled === true, JSON.stringify(r.body));
r = await call(admin, { action: 'run-autopilot', token: 'owner-key' });
check('the K6 run skips the suppressed contact', r.code === 200 && r.body.result.sent === 0, JSON.stringify(r.body));
check('suppression stops Lob before money can leave', lobCalls === 0);
r = await call(admin, { action: 'mail', token: 'owner-key', ids: [lead.id] });
check('manual postcard approval skips the suppressed contact too', r.code === 200 && r.body.sent === 0, JSON.stringify(r.body));
check('still no Lob spend', lobCalls === 0);
r = await call(switchBrain, {
  token: 'switch-key', name: lead.name, email: 'owner@quiet.example', phone: '9135550123', trade: lead.trade,
});
check('the AI outreach desk refuses the contact', r.code === 409 && r.body.error === 'contact_suppressed', JSON.stringify(r.body));
check('suppression stops Anthropic before tokens are spent', anthropicCalls === 0);

console.log('\nLIFTING IS OWNER-ONLY AND KEEPS THE HISTORY');
r = await call(admin, { action: 'unsuppress', token: 'owner-key', id: lead.id, suppressionId });
check('the owner can lift the suppression', r.code === 200 && r.body.record.active === false, JSON.stringify(r.body));
check('the active lookup is cleared', !(await getSuppression({ email: lead.email })));
const history = await listSuppressions({ activeOnly: false });
check('the audit record remains after lifting', history.length === 1 && history[0].liftedBy === 'operator');
r = await call(admin, { action: 'mail', token: 'owner-key', ids: [lead.id] });
check('outreach is available only after the lift', r.code === 200 && r.body.sent === 1, JSON.stringify(r.body));
check('the permitted postcard reaches Lob exactly once', lobCalls === 1);

console.log('\nA REP CANNOT TOUCH THE K6 CONTROLS');
r = await call(admin, { action: 'outreach-setconfig', token: 'rep-key', enabled: false });
check('a rep cannot change the outreach config', r.code === 403);
r = await call(admin, { action: 'run-outreach', token: 'rep-key' });
check('a rep cannot trigger an outreach run', r.code === 403);

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
