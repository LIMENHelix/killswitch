// admin-poll.js — the admin page's refresh cadence, in one testable place.
//
// WHY THIS FILE EXISTS: admin.html used to run setInterval(refresh, 20000)
// where one refresh fanned out to TEN /api/admin calls (list, config, funnel,
// disc-status, disc-candidates, draft-status, outreach-status, outreach-runs,
// outreach-effects, followup-status). That is ~1,800 requests/hour for one
// open owner tab, and an unattended tab burned the Upstash free-tier command
// budget from the inside (500k commands hard stop, 2026-09-19). Now:
//
//   light   every 60s   — the lead board (list)
//   status  every 5 min — funnel + pipeline/K6 status panels
//   detail  on action   — effects/follow-ups, only after a mutation or tab return
//
// A hidden tab polls nothing at all; returning to the tab runs one refresh.
// outreach-readiness is in NO tier: it scans the whole send pool, so it stays
// a manual button. UMD so test/admin-polling.mjs simulates the exact shipped
// schedule instead of a copy of it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AdminPoll = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const POLL = { lightMs: 60000, statusMs: 300000 };

  // Requests per tier, per role — the source of truth the regression test
  // sums over. Keep this in sync with refreshBoard/refreshStatus/
  // refreshDetail in admin.html; the test static-checks that sync.
  const ACTIONS = {
    light: ['list'],
    status: {
      owner: ['config', 'funnel', 'disc-status', 'disc-candidates', 'draft-status', 'outreach-status'],
      rep: ['funnel', 'disc-status', 'disc-candidates', 'draft-status'],
    },
    detail: { owner: ['outreach-effects', 'followup-status'], rep: [] },
  };

  class AdminPoller {
    constructor(opts) {
      opts = opts || {};
      this.lightMs = opts.lightMs || POLL.lightMs;
      this.statusMs = opts.statusMs || POLL.statusMs;
      this.onLight = opts.onLight || (async () => {});
      this.onStatus = opts.onStatus || (async () => {});
      this.onDetail = opts.onDetail || (async () => {});
      this.isVisible = opts.isVisible || (() => true);
      // Wrap, don't alias: Chrome throws "Illegal invocation" when a bare
      // setInterval reference is called without window as the receiver.
      this._setInterval = opts.setInterval || ((cb, ms) => setInterval(cb, ms));
      this._clearInterval = opts.clearInterval || ((id) => clearInterval(id));
      this._timers = null;
      this._inFlight = { light: false, status: false, detail: false };
    }

    get running() { return this._timers !== null; }

    // Idempotent: a second start() can never create overlapping loops.
    start() {
      if (this._timers) return false;
      const self = this;
      this._timers = [
        this._setInterval(function () { self._tick('light', self.onLight); }, this.lightMs),
        this._setInterval(function () { self._tick('status', self.onStatus); }, this.statusMs),
      ];
      return true;
    }

    stop() {
      if (!this._timers) return false;
      for (const t of this._timers) this._clearInterval(t);
      this._timers = null;
      return true;
    }

    // Timer entry point: fires only while running AND the tab is visible.
    _tick(kind, fn) {
      if (!this._timers || !this.isVisible()) return Promise.resolve('skipped');
      return this._run(kind, fn);
    }

    // In-flight dedupe: a second call for a tier while one is running is
    // dropped, so overlapping refresh cycles cannot stack up.
    async _run(kind, fn) {
      if (this._inFlight[kind]) return 'deduped';
      this._inFlight[kind] = true;
      try { await fn(); return 'ran'; }
      finally { this._inFlight[kind] = false; }
    }

    // One coalesced full refresh: after a mutation, and once when a hidden
    // tab becomes visible again. Runs even while timers are stopped (hidden
    // tabs cannot get here — nothing mutates from a hidden tab).
    async refreshAll() {
      const out = [];
      out.push(await this._run('light', this.onLight));
      out.push(await this._run('status', this.onStatus));
      out.push(await this._run('detail', this.onDetail));
      return out;
    }

    // Wire to document.visibilitychange: hiding stops polling cold;
    // returning restarts the timers and refreshes exactly once.
    handleVisibilityChange() {
      if (!this.isVisible()) { this.stop(); return null; }
      this.start();
      return this.refreshAll();
    }
  }

  return { POLL, ACTIONS, AdminPoller };
});
