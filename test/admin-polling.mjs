// REGRESSION: admin.html must never again fan out ten /api/admin calls every
// 20 seconds. That loop (~1,800 requests/hour for ONE open owner tab) is what
// burned the Upstash free-tier 500k-command budget on 2026-09-19 while the
// operator simply had the page open.
//
// This test simulates the SHIPPED schedule — admin-poll.js is imported, not
// copied — over virtual time, sums the request fanout per tier, and compares
// against the measured legacy loop. It also static-checks that admin.html is
// actually wired to the poller and that the tier functions call exactly the
// actions the fanout table claims.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
// The repo is ESM ("type": "module"), so require() would load the .js as ESM
// where the UMD's module.exports branch is dead. Evaluate it with a fake
// CommonJS module instead — the browser gets the window.AdminPoll branch.
const mod = { exports: {} };
new Function('module', 'exports',
  fs.readFileSync(path.join(ROOT, 'admin-poll.js'), 'utf8'))(mod, mod.exports);
const { AdminPoller, POLL, ACTIONS } = mod.exports;

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? '  <- ' + d : '')); fail++; } };

// The measured pre-fix loop: one refresh every 20s, fanning out to 10 admin
// calls for the owner (list, config, funnel, disc-status, disc-candidates,
// draft-status, outreach-status, outreach-runs, outreach-effects,
// followup-status) and 9 for a rep (no config, plus 4 owner-only 403s).
const LEGACY = { tickMs: 20000, fanout: { owner: 10, rep: 9 } };

// ---- virtual timer harness ----
function makeTimers() {
  const timers = [];
  let nextId = 0;
  let now = 0;
  return {
    timers,
    setInterval(cb, ms) { const t = { id: ++nextId, ms, cb, next: now + ms }; timers.push(t); return t.id; },
    clearInterval(id) { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    now: () => now,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        let soonest = null;
        for (const t of timers) if (!soonest || t.next < soonest.next) soonest = t;
        if (!soonest || soonest.next > end) break;
        now = soonest.next;
        soonest.next += soonest.ms;
        await soonest.cb();
      }
      now = end;
    },
  };
}

function makePoller(visibleRef) {
  const t = makeTimers();
  const counts = { light: 0, status: 0, detail: 0 };
  const p = new AdminPoller({
    onLight: async () => { counts.light++; },
    onStatus: async () => { counts.status++; },
    onDetail: async () => { counts.detail++; },
    isVisible: () => visibleRef.visible,
    setInterval: t.setInterval,
    clearInterval: t.clearInterval,
  });
  return { t, counts, p };
}

const requests = (counts, role) =>
  counts.light * ACTIONS.light.length +
  counts.status * ACTIONS.status[role].length +
  counts.detail * ACTIONS.detail[role].length;

const HOUR = 3600000;

// ---- 1. visible owner tab, 60 minutes: BEFORE vs AFTER ----
{
  const vis = { visible: true };
  const { t, counts, p } = makePoller(vis);
  p.start();
  await t.advance(HOUR);
  const legacyTicks = Math.floor(HOUR / LEGACY.tickMs); // 180
  const legacyReq = legacyTicks * LEGACY.fanout.owner; // 1800
  const nowReq = requests(counts, 'owner');
  check('visible 60min: light tier fires once/minute', counts.light === 60, 'light=' + counts.light);
  check('visible 60min: status tier fires once/5min', counts.status === 12, 'status=' + counts.status);
  check('visible 60min: detail tier never polled', counts.detail === 0, 'detail=' + counts.detail);
  check('visible 60min owner: ' + nowReq + ' requests vs legacy ' + legacyReq + ' (>85% cut)',
    nowReq === 132 && nowReq <= legacyReq * 0.15, 'now=' + nowReq + ' legacy=' + legacyReq);
  const repReq = requests(counts, 'rep');
  check('rep fanout is smaller (owner-only actions never attempted)', repReq === 60 + 12 * 4, 'rep=' + repReq);
}

// ---- 2. hidden tab, 60 minutes: near-zero polling ----
{
  const vis = { visible: true };
  const { t, counts, p } = makePoller(vis);
  p.start();
  await t.advance(70000); // one light tick lands first
  const beforeHide = { ...counts };
  vis.visible = false;
  p.handleVisibilityChange();
  check('hiding stops the timers', p.running === false);
  await t.advance(HOUR);
  check('hidden 60min: zero polls', counts.light === beforeHide.light && counts.status === beforeHide.status && counts.detail === beforeHide.detail,
    JSON.stringify(counts));
}

// ---- 3. reopening the tab triggers exactly one refresh cycle ----
{
  const vis = { visible: true };
  const { t, counts, p } = makePoller(vis);
  p.start();
  await t.advance(70000); // light=1
  vis.visible = false; p.handleVisibilityChange();
  await t.advance(600000); // nothing
  vis.visible = true;
  await p.handleVisibilityChange(); // restart + one refreshAll
  check('tab return: exactly one light refresh', counts.light === 2, 'light=' + counts.light);
  check('tab return: exactly one status refresh', counts.status === 1, 'status=' + counts.status);
  check('tab return: exactly one detail refresh', counts.detail === 1, 'detail=' + counts.detail);
  check('tab return: timers running again', p.running === true);
}

// ---- 4. no overlapping refresh cycles ----
{
  const vis = { visible: true };
  const t = makeTimers();
  let release;
  const blocker = new Promise((r) => { release = r; });
  let lightCalls = 0;
  const p = new AdminPoller({
    onLight: async () => { lightCalls++; await blocker; },
    onStatus: async () => {},
    isVisible: () => vis.visible,
    setInterval: t.setInterval, clearInterval: t.clearInterval,
  });
  p.start();
  p.start(); // second start must be a no-op
  check('double start() cannot create a second loop', t.timers.length === 2, 'timers=' + t.timers.length);
  const tick1 = t.advance(60000); // light tick 1 fires and blocks in-flight
  await new Promise((r) => setImmediate(r));
  await t.advance(60000); // light tick 2 fires while tick 1 is in flight
  await tick1;
  release();
  check('in-flight light tier dedupes the next tick', lightCalls === 1, 'calls=' + lightCalls);
}

// ---- 5. mutation refresh: once, coalesced ----
{
  const vis = { visible: true };
  const { counts, p } = makePoller(vis);
  p.start();
  let release;
  const blocker = new Promise((r) => { release = r; });
  p.onStatus = async () => { counts.status++; await blocker; };
  const m1 = p.refreshAll();
  const m2 = p.refreshAll(); // rapid second mutation while the first is mid-flight
  await new Promise((r) => setImmediate(r));
  release();
  await Promise.all([m1, m2]);
  check('two rapid mutations coalesce the in-flight status refresh', counts.status === 1, 'status=' + counts.status);
  check('mutation refresh dedupes the light tier', counts.light === 1, 'light=' + counts.light);
  // Detail is not blocked by the slow status call: each mutation refresh runs
  // it once, sequentially — two mutations, two detail runs, never overlapping.
  check('detail runs once per mutation, never overlapping', counts.detail === 2, 'detail=' + counts.detail);
}

// ---- 6. expensive scans stay manual ----
check('outreach-readiness is in NO poll tier (manual button only)',
  !JSON.stringify(ACTIONS).includes('outreach-readiness'));
check('schedule constants are the documented ones',
  POLL.lightMs === 60000 && POLL.statusMs === 300000, JSON.stringify(POLL));

// ---- 7. admin.html is actually wired this way ----
const html = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
const fnBody = (name) => {
  const start = html.indexOf('async function ' + name + '(');
  if (start < 0) return '';
  let i = html.indexOf('{', start), depth = 0;
  for (let j = i; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') { depth--; if (!depth) return html.slice(i, j + 1); }
  }
  return '';
};
check('legacy 20s blanket loop is gone', !/setInterval\(refresh/.test(html));
check('page loads the shared poller script', html.includes('/admin-poll.js'));
check('page listens for visibilitychange', html.includes("addEventListener('visibilitychange'"));
check('poller is constructed from AdminPoll.AdminPoller', html.includes('new AdminPoll.AdminPoller('));
check('boot starts the poller', /poller\.start\(\)/.test(fnBody('boot')));
const board = fnBody('refreshBoard');
check('light tier calls only list', (board.match(/api\('/g) || []).length === 1 && board.includes("api('list')"), board.match(/api\('[^']+'/g));
const status = fnBody('refreshStatus');
check('status tier makes no direct api() calls (goes through the loaders)', !/api\('/.test(status));
check('status tier loads legacy/funnel/disc/draft for the right roles',
  status.includes("loadLegacy()") && status.includes('loadFunnel()') && status.includes('loadDisc()') && status.includes('loadDraft()'));
check('outreach status stays owner-only (no rep 403 fanout)', /ROLE==='owner'\) loadOutreach\(\)/.test(status));
const out = fnBody('loadOutreach');
check('loadOutreach no longer re-fetches runs (status payload already has them)', !out.includes("api('outreach-runs'"));
const detail = fnBody('loadOutreachDetail');
check('detail tier is effects + followups only',
  detail.includes("api('outreach-effects'") && detail.includes("api('followup-status'") && (detail.match(/api\('/g) || []).length === 2);
const save = fnBody('') === '' && html.includes("$('outreachSave').onclick=async()=>{");
const saveBody = html.slice(html.indexOf("$('outreachSave').onclick"), html.indexOf("$('outreachRun').onclick"));
check('config mutation refreshes once through the deduped poller',
  (saveBody.match(/await refresh\(\)/g) || []).length === 1);
check('manual readiness button still wired', html.includes("$('readinessCheck').onclick=async()=>{")
  && html.includes("api('outreach-readiness')"));

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
