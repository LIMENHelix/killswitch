// THE JOIN, AND THE ALARM.
//
// An account and the website it pays for are tied together by nothing but an
// email string in a Redis hash. syncModules() returns null when that lookup
// misses, and all six of its callers threw that null away, so a customer could
// be charged and have nothing happen anywhere with no error raised. These run
// the real lib/site-link.js against a real lib/sites.js over a fake Redis, and
// prove the null is now reported, that reporting it does not turn into a hundred
// identical emails, and that the join will not hand one customer another
// customer's website.
process.env.KV_REST_API_URL = 'https://kv.test/';
process.env.KV_REST_API_TOKEN = 'kvtok';
process.env.RESEND_API_KEY = 'resend-test-key';
process.env.KS_NOTIFY_EMAIL = 'operator@example.com';
process.env.KS_PANEL_SECRET = 'panel-test-secret';

const KV = new Map();
const mails = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  if (u.includes('api.resend.com')) { mails.push(JSON.parse(opts.body)); return json({ id: 'mail_' + mails.length }); }

  const args = JSON.parse(opts.body);
  const run = (a) => {
    const c = String(a[0]).toUpperCase(), k = a[1];
    if (c === 'GET') return KV.has(k) ? KV.get(k) : null;
    if (c === 'SET') {
      // Upstash returns null, not 'OK', when NX finds the key already there.
      // The quiet gate depends on that exact distinction.
      const flags = a.slice(3).map((x) => String(x).toUpperCase());
      if (flags.includes('NX') && KV.has(k)) return null;
      KV.set(k, a[2]); return 'OK';
    }
    if (c === 'DEL') { const had = KV.has(k); KV.delete(k); return had ? 1 : 0; }
    if (c === 'HSET') { const h = KV.get(k) || {}; h[a[2]] = a[3]; KV.set(k, h); return 1; }
    if (c === 'HGET') { const h = KV.get(k) || {}; return h[a[2]] == null ? null : h[a[2]]; }
    if (c === 'HDEL') { const h = KV.get(k) || {}; const had = a[2] in h; delete h[a[2]]; KV.set(k, h); return had ? 1 : 0; }
    if (c === 'HGETALL') { const h = KV.get(k) || {}; const o = []; for (const [f, v] of Object.entries(h)) o.push(f, v); return o; }
    throw new Error('unsupported kv command in test: ' + c);
  };
  if (u.endsWith('/pipeline')) return json(args.map((a) => ({ result: run(a) })));
  return json({ result: run(args) });
};

const S = await import('../lib/sites.js');
const L = await import('../lib/site-link.js');
const { onboardCustomer } = await import('../lib/onboard.js');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };
const alerts = () => mails.filter((m) => /not delivered|no website attached/i.test(m.subject || ''));
const since = (n) => alerts().length - n;

console.log('\nA PAID SWITCH THAT RENDERS NOWHERE MUST NOT BE SILENT');

// --- the fault itself: money taken, nothing to deliver to ---
let n = alerts().length;
const orphan = await L.syncModulesLoud('ghost@example.com', ['P1', 'P3'], 'test-checkout');
check('syncModulesLoud still returns null, so no caller changes behaviour', orphan === null, JSON.stringify(orphan));
check('and it raised exactly one operator alert', since(n) === 1, String(since(n)));
check('the alert names the customer', (alerts().at(-1).html || '').includes('ghost@example.com'));
check('and names the modules in English, not P-codes',
  /Get Found on Google/.test(alerts().at(-1).html || ''), (alerts().at(-1).html || '').slice(0, 400));

let list = await L.listUnlinked();
check('the gap is recorded so /master can show it', list.length === 1 && list[0].email === 'ghost@example.com', JSON.stringify(list));
check('it records WHERE it happened', list[0].where === 'test-checkout', JSON.stringify(list[0]));

// --- THE PART THAT MAKES THE ALERT USABLE. /panel calls syncModules on every
// load, so without a quiet gate one unlinked customer refreshing their page
// sends a hundred identical emails and you learn to ignore all of them. ---
n = alerts().length;
await L.syncModulesLoud('ghost@example.com', ['P1', 'P3'], 'test-panel-load');
await L.syncModulesLoud('ghost@example.com', ['P1', 'P3'], 'test-panel-load');
await L.syncModulesLoud('ghost@example.com', ['P1', 'P3'], 'test-panel-load');
check('three more failures do NOT send three more emails', since(n) === 0, String(since(n)));
list = await L.listUnlinked();
check('but the count still climbs, so the real scale is visible', list[0].count === 4, JSON.stringify(list[0]));

// --- the healthy path is untouched ---
await S.upsertSite({ business: 'Bright Spark Electric', email: 'bright@example.com', published: true });
n = alerts().length;
const ok = await L.syncModulesLoud('bright@example.com', ['P1', 'P3'], 'test-checkout');
check('a linked customer gets a real record back', !!ok && ok.slug === 'bright-spark-electric', JSON.stringify(ok && ok.slug));
check('the modules are actually written to the site',
  JSON.stringify((ok || {}).modules) === JSON.stringify(['P0', 'P1', 'P3']), JSON.stringify((ok || {}).modules));
check('and nobody is emailed about a customer who is fine', since(n) === 0, String(since(n)));

// --- recovery: once a customer is joined, they stop being counted as broken ---
await S.upsertSite({ business: 'Ghost Trades', email: 'ghost@example.com' });
await L.syncModulesLoud('ghost@example.com', ['P1'], 'test-after-fix');
list = await L.listUnlinked();
check('fixing the join clears the outstanding fault', list.length === 0, JSON.stringify(list));

console.log('\nTHE JOIN ITSELF');

// --- the same business typed three ways has to reach the same slug, or the
// join misses for exactly the reason it was missing before ---
const c1 = L.slugCandidates({ site: 'https://www.mesaroofing.com/quote' });
check('a full URL reduces to the bare business name', c1.includes('mesaroofing'), JSON.stringify(c1));
check('and keeps the domain form too, in case that is how it was saved', c1.includes('mesaroofing-com'), JSON.stringify(c1));
check("a typed business name still works", L.slugCandidates({ site: "Mesa Roofing Co." }).includes('mesa-roofing-co'),
  JSON.stringify(L.slugCandidates({ site: "Mesa Roofing Co." })));

await S.upsertSite({ business: 'Mesa Roofing', published: true }); // no email: nobody owns it yet
const bound = await L.linkAccountToSite({ email: 'jo@mesaroofing.com', site: 'https://www.mesaroofing.com' });
check('an unowned site is bound to the account that matches it', bound.linked && bound.reason === 'bound', JSON.stringify(bound));
check('and siteForEmail can now find it, which is the whole point',
  !!(await S.siteForEmail('jo@mesaroofing.com')), 'siteForEmail returned nothing');

// --- THE DANGEROUS ONE. Two businesses with similar names is ordinary. Handing
// one customer another customer's live website is not. ---
await S.upsertSite({ business: 'Apex Plumbing', email: 'first@apex.com', published: true });
const steal = await L.linkAccountToSite({ email: 'second@apex.com', site: 'Apex Plumbing' });
check('a site owned by someone else is NOT taken', !steal.linked && steal.reason === 'owned_by_other', JSON.stringify(steal));
check('and the real owner still owns it',
  (await S.getSite('apex-plumbing')).email === 'first@apex.com', (await S.getSite('apex-plumbing')).email);
check('the interloper is still unattached',
  (await S.siteForEmail('second@apex.com')) === null, 'second@apex.com resolved to a site');

// --- collapsing the hyphens is what made mesaroofing.com reach mesa-roofing,
// and it is also what can make two different businesses look like one ---
await S.upsertSite({ business: 'Joes Plumbing', published: true });
await S.upsertSite({ business: 'Joe Splumbing', published: true });
check('two records really do collapse to the same key',
  (await S.getSite('joes-plumbing')) && (await S.getSite('joe-splumbing')), 'the collision setup itself failed');
const tie = await L.linkAccountToSite({ email: 'joe@joesplumbing.com', site: 'joesplumbing.com' });
check('when two businesses collapse to one key it refuses to guess',
  !tie.linked && tie.reason === 'ambiguous', JSON.stringify(tie));
check('and neither record was touched',
  !(await S.getSite('joes-plumbing')).email && !(await S.getSite('joe-splumbing')).email,
  JSON.stringify([(await S.getSite('joes-plumbing')).email, (await S.getSite('joe-splumbing')).email]));

// --- an exact slug still wins outright, so the fuzzy pass can never override it ---
await S.upsertSite({ business: 'Vale Glass', published: true });
await S.upsertSite({ business: 'Valeglass', published: true });
const exact = await L.linkAccountToSite({ email: 'v@vale.com', site: 'Vale Glass' });
check('an exact match is taken before the collapsed one is even considered',
  exact.linked && exact.slug === 'vale-glass', JSON.stringify(exact));

// --- it must not invent a website for someone who has none ---
const none = await L.linkAccountToSite({ email: 'nobody@example.com', site: 'Nothing Here Ltd' });
check('no matching record means no record is fabricated', !none.linked && none.reason === 'no_site_record', JSON.stringify(none));
check('and nothing was written under that slug', (await S.getSite('nothing-here-ltd')) === null);

console.log('\nENDING A CYCLE, AND THE TWO REASONS FOR A NULL');

// removeModules returns null for two different reasons: nothing to drop, and no
// site found. Only the second is a fault. Reporting both would cry wolf daily.
n = alerts().length;
const nothing = await L.removeModulesLoud('ghost@example.com', [], 'paid-cycle-ended');
check('an empty phase list is not a fault', nothing === null && since(n) === 0, String(since(n)));

n = alerts().length;
const lost = await L.removeModulesLoud('vanished@example.com', ['P4'], 'paid-cycle-ended');
check('but a module expiring against no site is reported', lost === null && since(n) === 1, String(since(n)));
check('and the alert says it should have ENDED, not that it is paid for',
  /should have ended/i.test(alerts().at(-1).html || ''), (alerts().at(-1).html || '').slice(0, 300));

console.log('\nONBOARDING NOW MAKES THE JOIN INSTEAD OF HOPING FOR IT');

await S.upsertSite({ business: 'Cedar Fence Pros', published: true });
const good = await onboardCustomer({ email: 'sam@cedarfencepros.com', site: 'Cedar Fence Pros', name: 'Sam' });
check('a new customer is joined to their site at signup',
  good.ok && good.link && good.link.linked, JSON.stringify(good.link));
check('the account and the site now resolve to each other',
  (await S.siteForEmail('sam@cedarfencepros.com')).slug === 'cedar-fence-pros');

n = alerts().length;
const bad = await onboardCustomer({ email: 'pat@nosuchsite.com', site: 'No Such Site', name: 'Pat' });
check('onboarding still SUCCEEDS when no site matches, so the sale is never lost', bad.ok === true, JSON.stringify(bad.ok));
check('but it reports that it did not join', bad.link && bad.link.linked === false, JSON.stringify(bad.link));
check('and the operator is told the same minute', since(n) === 1, String(since(n)));

console.log('\nTHE WELCOME EMAIL MUST NOT PROMISE A SITE THAT DOES NOT EXIST');

// "Your website is live and it is yours" went out unconditionally, including to
// people who had no site record at all. These read the mail that was actually
// sent, not the code that composes it.
const welcome = (to) => mails.filter((m) => (m.to || []).includes(to)).at(-1);

const w1 = welcome('sam@cedarfencepros.com'); // joined to a published site
check('a customer with a real live site is still told it is live',
  !!w1 && /website is live and it is yours/i.test(w1.html || ''), w1 ? (w1.html || '').slice(0, 200) : 'no mail sent');
check('and the subject line says so too', !!w1 && /website is live/i.test(w1.subject || ''), w1 && w1.subject);

const w2 = welcome('pat@nosuchsite.com'); // no site record at all
check('a customer with NO site is not told they have one',
  !!w2 && !/website is live/i.test(w2.html || ''), w2 ? (w2.html || '').slice(0, 300) : 'no mail sent');
check('the subject line does not claim it either', !!w2 && !/website is live/i.test(w2.subject || ''), w2 && w2.subject);
check('it says what is actually true instead',
  !!w2 && /account is set up/i.test(w2.html || ''), w2 && (w2.html || '').slice(0, 300));
check('and they still get their panel link, so nothing was taken away',
  !!w2 && (w2.html || '').includes('/panel?e='), 'no panel link in the mail');

// published:false is a hard 404. Joined is not the same as live, and the mail
// has to know the difference or it is wrong in a second, quieter way.
await S.upsertSite({ business: 'Quarry Tile', published: false });
await onboardCustomer({ email: 'dee@quarrytile.com', site: 'Quarry Tile', name: 'Dee' });
const w3 = welcome('dee@quarrytile.com');
check('a joined but UNPUBLISHED site does not count as live either',
  !!w3 && !/website is live/i.test(w3.html || ''), w3 ? (w3.html || '').slice(0, 300) : 'no mail sent');

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
