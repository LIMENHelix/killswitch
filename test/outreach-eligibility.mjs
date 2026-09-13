// K6 pre-outreach safety test: prospect-contact eligibility.
//
// Verifies that checkProspectEligibility rejects anyone who is suppressed, a
// current/paid customer, attached to a claimed/paid site, or already has their
// own website, and accepts only clean targets.

process.env.KV_REST_API_URL = 'https://kv.outreach.test';
process.env.KV_REST_API_TOKEN = 'tok';
delete process.env.VERCEL_ENV;

import { setupKvStub, clearKvStub } from './helpers/k6-kv.mjs';

const { KV, EXP } = setupKvStub();

const { checkProspectEligibility } = await import('../lib/outreach-eligibility.js');
const { suppressContact } = await import('../lib/suppression.js');
const { upsertAccount } = await import('../lib/store.js');
const { upsertSite } = await import('../lib/sites.js');

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log('  PASS  ' + name);
    passed++;
  } else {
    console.log('  FAIL  ' + name + (detail ? ' <- ' + detail : ''));
    failed++;
  }
}

function reset() {
  KV.clear();
  EXP.clear();
}

const baseLead = {
  id: 'lead-1',
  business: 'River Auto',
  name: 'River Auto',
  city: 'Kansas City',
  state: 'MO',
  street: '123 Main St',
  zip: '64108',
  phone: '816-555-0142',
  email: 'owner@riverauto.test',
};

console.log('\nELIGIBLE PROSPECTS');
reset();
let r = await checkProspectEligibility({ ...baseLead, website: '' });
check('a clean prospect with no website is eligible', r.eligible === true && r.reason === 'eligible');

reset();
r = await checkProspectEligibility({ ...baseLead, website: 'https://facebook.com/riverauto' });
check('a prospect with only a Facebook page is eligible', r.eligible === true);

reset();
r = await checkProspectEligibility({ ...baseLead });
check('a prospect with no website field is eligible', r.eligible === true);

console.log('\nSUPPRESSION');
reset();
await suppressContact({ email: baseLead.email }, { reason: 'stop', actor: 'test' });
r = await checkProspectEligibility(baseLead);
check('a suppressed email is rejected', r.eligible === false && r.reason === 'suppressed');

reset();
await suppressContact({ phone: baseLead.phone }, { reason: 'stop', actor: 'test' });
r = await checkProspectEligibility(baseLead);
check('a suppressed phone is rejected', r.eligible === false && r.reason === 'suppressed');

reset();
await suppressContact(
  { street: baseLead.street, city: baseLead.city, state: baseLead.state, zip: baseLead.zip },
  { reason: 'stop', actor: 'test' }
);
r = await checkProspectEligibility(baseLead);
check('a suppressed postal address is rejected', r.eligible === false && r.reason === 'suppressed');

console.log('\nEXISTING SITES BY NAME AND CITY');
reset();
await upsertSite({
  slug: 'river-auto', business: 'River Auto', city: 'Kansas City', state: 'MO',
  modules: ['P0'], claimed: true, published: true,
});
r = await checkProspectEligibility(baseLead);
check('a claimed site matching name+city rejects', r.eligible === false && r.reason === 'claimed_site');

reset();
await upsertSite({
  slug: 'river-auto', business: 'River Auto', city: 'Kansas City', state: 'MO',
  modules: ['P0', 'P1'], claimed: false, published: true,
});
r = await checkProspectEligibility(baseLead);
check('a paid site matching name+city rejects', r.eligible === false && r.reason === 'paid_site');

reset();
await upsertSite({
  slug: 'river-auto-1', business: 'River Auto', city: 'Kansas City', state: 'MO',
  modules: ['P0'], claimed: false, published: true,
});
await upsertSite({
  slug: 'river-auto-2', business: 'River Auto', city: 'Kansas City', state: 'MO',
  modules: ['P0'], claimed: false, published: true,
});
r = await checkProspectEligibility(baseLead);
check('multiple sites matching name+city reject as ambiguous', r.eligible === false && r.reason === 'ambiguous_identity');

console.log('\nPHONE RECONCILIATION');
reset();
await upsertSite({
  slug: 'river-auto', business: 'River Auto', city: 'Kansas City',
  phone: '816-555-0142', modules: ['P0'], claimed: true, published: true,
});
r = await checkProspectEligibility(baseLead);
check('phone matching a claimed site rejects', r.eligible === false && r.reason === 'claimed_site');

reset();
await upsertSite({
  slug: 'river-auto', business: 'River Auto', city: 'Kansas City',
  phone: '816-555-0142', modules: ['P0', 'P1'], claimed: false, published: true,
});
r = await checkProspectEligibility(baseLead);
check('phone matching a paid site rejects', r.eligible === false && r.reason === 'paid_site');

reset();
await upsertAccount({ email: 'other@example.com', phone: '816-555-0142', plan: ['P0'], stripeCustomerId: 'cus_x' });
r = await checkProspectEligibility(baseLead);
check('phone matching a paid account rejects', r.eligible === false && r.reason === 'paid_customer');

reset();
await upsertAccount({ email: 'other@example.com', phone: '816-555-0142', plan: ['P0'] });
r = await checkProspectEligibility(baseLead);
check('phone matching a current account rejects', r.eligible === false && r.reason === 'current_customer');

reset();
await upsertSite({
  slug: 'river-auto', business: 'River Auto', city: 'Kansas City',
  phone: '816-555-0142', modules: ['P0'], claimed: false, published: true,
});
await upsertAccount({ email: 'other@example.com', phone: '816-555-0142', plan: ['P0'] });
r = await checkProspectEligibility(baseLead);
check('phone matching multiple records rejects as ambiguous', r.eligible === false && r.reason === 'ambiguous_identity');

console.log('\nEMAIL RECONCILIATION');
reset();
await upsertAccount({ email: baseLead.email, plan: ['P0'], stripeCustomerId: 'cus_x' });
r = await checkProspectEligibility(baseLead);
check('email matching a paid account rejects', r.eligible === false && r.reason === 'paid_customer');

reset();
await upsertAccount({ email: baseLead.email, plan: ['P0'] });
r = await checkProspectEligibility(baseLead);
check('email matching a current account rejects', r.eligible === false && r.reason === 'current_customer');

reset();
await upsertSite({
  slug: 'river-auto', business: 'River Auto', city: 'Kansas City',
  email: baseLead.email, modules: ['P0'], claimed: true, published: true,
});
r = await checkProspectEligibility(baseLead);
check('email matching a claimed site rejects', r.eligible === false && r.reason === 'claimed_site');

reset();
await upsertSite({
  slug: 'river-auto', business: 'River Auto', city: 'Kansas City',
  email: baseLead.email, modules: ['P0', 'P1'], claimed: false, published: true,
});
r = await checkProspectEligibility(baseLead);
check('email matching a paid site rejects', r.eligible === false && r.reason === 'paid_site');

reset();
await upsertAccount({ email: baseLead.email, plan: ['P0'] });
await upsertSite({
  slug: 'river-auto', business: 'River Auto', city: 'Kansas City',
  email: baseLead.email, modules: ['P0'], claimed: false, published: true,
});
r = await checkProspectEligibility(baseLead);
check('email matching both account and site rejects as ambiguous', r.eligible === false && r.reason === 'ambiguous_identity');

console.log('\nWEBSITE PRESENCE');
reset();
r = await checkProspectEligibility({ ...baseLead, website: 'https://riverauto.com' });
check('a prospect with its own website rejects', r.eligible === false && r.reason === 'has_site');

reset();
r = await checkProspectEligibility({ ...baseLead, webStatus: 'has_site' });
check('an explicit has_site webStatus rejects', r.eligible === false && r.reason === 'has_site');

console.log('\nOPTIONS AND CACHES');
reset();
r = await checkProspectEligibility(baseLead, { channel: 'postcard' });
check('channel is recorded in the result', r.channel === 'postcard');

reset();
r = await checkProspectEligibility(baseLead, {
  suppressionState: {},
  accountList: {},
  siteList: [],
  siteEmailMap: {},
});
check('passing empty caches produces an eligible result', r.eligible === true);

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
clearKvStub();
process.exit(failed ? 1 : 0);
