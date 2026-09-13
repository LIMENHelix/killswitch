# K4 — Prospect Discovery / Ranking Autonomy Audit

**Repo:** LIMENHelix/killswitch
**Audited commit:** `0872918a93825d490149959e4ba9d1e7a0f5e7b9` (origin/main = production, PR #20 merge)
**Audit type:** READ-ONLY. No edits, no commits at audit time, no external calls, no bulk discovery runs.
**Date:** 2026-09-11

---

## Purpose

Determine exactly what Killswitch already has for autonomous prospect discovery,
qualification, ranking, dedupe, suppression, site drafting, and handoff — and
identify the smallest missing slice for bounded unattended:

```
discovery → qualification → durable candidate storage → ranking → safe handoff
```

…without automatically contacting anyone. This document is the audit record; it
changes no behavior.

---

## Chain Table

| # | Stage | Current file/function | Trigger | Durable state | Idempotent? | Autonomous today? | Outreach side effect? | Gap |
|---|-------|----------------------|---------|---------------|-------------|-------------------|----------------------|-----|
| 1 | discovery | `api/find.js` (Places searchText, ≤2 pages, owner-token POST) | Operator click (`master.html` finder UI) or `_outreach/pull.py` | **None** — response JSON only | Run-local name/host dedupe only | **NO** | None (verified: no store writes, no mailer imports) | No persistence, no scan cursor, no run cap, no dedupe vs storage |
| 2 | normalization | `lib/web-presence.js:classify()` — ~60-host suffix table → `none/facebook_only/directory_only/booking_only/diy_builder/has_site` | Inline in find response | None (pure) | Deterministic | n/a | None | Labels only — nothing downstream consumes them except filtering in find |
| 3 | dedupe | `api/find.js:136-146` `seen`/`seenHost` (single run only); ingestion = `admin.js:161 'seed'` → `saveLeads()` **full blob replace** | seed: owner action | `ks:leads` blob | **NO cross-run dedupe** | NO | None | **No canonical identity** — no placeId stored (Places `id` is in the field mask, never persisted), no domain key |
| 4 | qualification | `segment()` — explicitly "a label, not a ranking" (`find.js:158`) | — | None | — | NO | None | **No qualification gate exists** |
| 5 | suppression/exclusion | `lib/suppression.js` — `ks:suppressions`, SHA-256 fingerprints over id/email/phone/address | writes: admin suppress/unsuppress | `ks:suppressions` | Enrich-not-duplicate | Partial — enforced on every **send** path | Blocks spend | **Discovery/seed never reads it**; **no customer/site/paid exclusion anywhere in the mail path** — a paying customer in the lead list gets a postcard unless suppressed |
| 6 | candidate persistence | `ks:leads` blob + `ks:leads:inbound` hash + `ks:leadmeta`; local `leads.csv` (operator machine only) | owner seed / voice agent / inbound | Yes (last-write-wins blob) | Inbound idempotent per email-hash; discovered rows not | NO (manual CSV→KV chain) | None | **No discovered→qualified→ranked state machine** |
| 7 | scoring | `lib/laser.js:scorePlay/wilsonLower` — scores **plays** (channel tactics), never prospects | on-read from `ks:funnel` | None on leads (grep: zero `score`/`rank` keys) | Pure/deterministic | n/a | None | **No prospect score exists at all** |
| 8 | ranking | `laser.js:allocate` — ranks plays only; admin 'list' returns stored order | on-read | None | — | NO | None | **No prospect ordering — the board is an unordered list** |
| 9 | free-site drafting | `lib/draft-site.js:draftFromLead` ← `master.js:294 site-bulk-draft` (owner-only button); `lib/autonomy.js:ensureCustomerSite` (inbound/stripe); `mailer.js:publishForMail` (publishes on postcard) | owner click / customer action / postcard send | `ks:site:<slug>` (`published:false`, `proposed{}`) | Yes — leadId dedupe, slug `taken` set, content-preservation branches (test-asserted) | NO | Publishing only (unclaimed/noindex) | Drafting consumes **zero AI/network**; safe, but reachable only by operator |
| 10 | outreach handoff | Postcard: `mailer.js:runAutopilot` (**default OFF**, owner `setconfig` + lifetime ceiling required) / `admin.js:240 mail` (owner ids) · Email: `onboard.js`, `cron-followups` queue (inbound-triggered only) · AI desk: `switch-brain.js` (suppression-checked, output to operator's own inbox) · Voice: `api/agent.js` (inbound calls only) · SMS: **does not exist** | owner arm / customer action / phone call | mixed | Yes (queue: lease + idempotency keys + terminal ledgers) | Only when owner armed | By design, gated | **Nothing arms from discovery** — verified call graph |
| 11 | conversion reconciliation | `ensureCustomerSite` claims unowned drafts by slug; `lib/lifecycle.js` by email; `lib/funnel.js` stages (all post-touch); claim-reminder re-derives engaged/paid/suppressed/site at send time | inbound / stripe webhook | `ks:lifecycle:*`, `ks:acct`, `ks:funnel` | Idempotency-key namespaced | Yes (for existing flows) | None | Prospects have no lifecycle until first touch; funnel starts at `lead` stage |

---

## Exact Answers

### A. What already works unattended?

The four crons (`cron-mail` when armed, `cron-followups` every 5 min,
`cron-maintenance` hourly, `cron-scorecard` weekly) — all fail-closed on
CRON_SECRET, all bounded, retry-safe (leases / NX claims / sent-keys), three
test-asserted. Everything upstream of them — discovery, dedupe, persistence,
drafting — is operator-driven. *(MEASURED)*

### B. What still requires an operator?

Every stage 1–9 trigger: running the finder, saving results (seed), drafting
sites (bulk-draft button), arming any outreach, AI writing. *(MEASURED)*

### C. Canonical prospect identity?

**None.** Four fragmented identities: lead-row `id` (source-dependent), site
`slug` (joined via `leadId`/`siteSlug`), account email (only post-signup), CRM
contact handle. The Google `placeId` is fetched in the field mask and **never
stored** — the single strongest free discriminator is thrown away. Suppression
bridges identities via hashed fingerprints, but nothing else does. *(MEASURED)*

### D. Is there already durable candidate state?

**No pre-outreach candidate state machine.** No `discovered/qualified/ranked`
keys anywhere (the one `'qualified'` string is in `rep-action.js`, which is
broken — see blockers). Closest existing pre-contact state: lead rows +
unpublished draft site records awaiting human approval. *(MEASURED)*

### E. Can discovery be separated completely from outreach?

**Yes — it already is.** `api/find.js` imports only `web-presence.js` and
`roles.js`; zero store writes, zero contact paths. Turning discovery on cannot
arm outreach: postcard autopilot requires an explicit owner `setconfig` with a
lifetime budget ceiling (`store.js:82-85`, `admin.js:144-153`); every other
channel is customer/inbound-call triggered. *(MEASURED, call graph)*

### F. What external-cost controls already exist?

- **Lob:** best-in-class — daily cap, lifetime ceiling with self-trip +
  operator alert, PER_RUN=50, ATTEMPT_CAP=400, suppression pre-check.
- **Resend queue paths:** idempotency keys + lease + dead-letter.
- **Places (`api/find.js`):** per-request ≤2 paid calls, but **no daily cap, no
  cache, no timeout on the fetch, no dedupe against storage** — one leaked
  owner token = unbounded spend; the rate-ceiling pattern used by other spendy
  routes (`lib/ratelimit.js`) is **not** applied here.
- **Anthropic (switch-brain/site-writer):** record-only ledger, no throttle.
  *(MEASURED)*

### G. Decisions needed from Chris

1. **Run/daily caps and geography/trade scope** for unattended discovery.
2. **Canonical identity choice** — audit read: persist the Places `placeId`
   (already fetched, free) + normalized name+geo; Chris decides whether that's
   the key.
3. **Autonomy arm model** — same pattern as postcard autopilot (config
   default-OFF, owner setconfig to enable)?
4. **Seed semantics** — current `seed` is destructive replace-all;
   merge/upsert would be a behavior change to an owner endpoint.
5. **Whether the "no customer/paid exclusion in mail" gap** should be fixed as
   part of K4 or separately (it's a live correctness issue, not just autonomy).
6. **Rep endpoints** (`rep-action.js`/`rep-board.js`) — dead code (bad import +
   wrong meta key, 500s on every write): fix or delete?
7. The **committed token default in `_outreach/pull.py:18`** — rotate if it's
   live; remove regardless (security debt).

### H. Single smallest next PR (recommendation — NOT implemented)

A **bounded, default-OFF discovery-and-rank slice** that:

- adds a config-gated discovery job (new cron or `cron-maintenance` slot — it
  already hosts bounded jobs) that runs N trade×city queries per invocation,
  with a server-side fetch timeout + daily Places cap added to `api/find.js`
  first,
- persists candidates durably keyed by **placeId** (normalize + dedupe across
  runs, collapse against existing `ks:leads`/sites/accounts/suppressions at
  write time),
- scores deterministically from fields already collected (web_status, rating,
  reviews, trade weight) — a pure function, no new intake,
- marks candidates `ranked` and **stops**. Zero contact, zero drafting, zero
  publishing — handoff to the existing owner-driven draft/mail machinery stays
  manual.

This wires existing pieces (find, web-presence, suppression fingerprints,
autopilot's config-gate pattern, cron conventions) — no new subsystem. It
defaults to current behavior (everything off/manual) and cannot contact anyone.

---

## Security Sweep

- Discovery endpoint: owner-token authenticated; Places key never exposed
  (server-side header). *(MEASURED)*
- Cron auth: all four fail closed, both-sides checks; no `x-vercel-cron` trust.
  *(MEASURED, 3 test-asserted; cron-mail by identical pattern, UNTESTED)*
- **Committed credential default in `_outreach/pull.py:18`** (+2 sibling
  scripts) — security debt, flagged by presence only. *(MEASURED presence)*
- No SSRF (all fetches to constant hosts); `api/find.js` 502 echoes up to 200
  chars of Google's error text (minor upstream-info leak). *(MEASURED)*
- No public candidate listing; no cross-customer mutation; no fake-data
  fallback (scorecard explicitly refuses to guess; `site-seed` test-asserted to
  invent nothing); preview gating present. *(MEASURED)*
- `onboardCustomer` welcome email lacks a Resend idempotency key —
  provider-accept + local crash could duplicate a customer-visible mail.
  *(MEASURED code; impact UNMEASURED)*
- `runAutopilot` reads/rewrites the whole leads blob — owner `mail` + cron
  overlap could interleave writes. *(DERIVED)*

## Blockers / Debt Found (not K4 scope, flagged)

1. **`api/rep-action.js` + `api/rep-board.js` are broken** — import nonexistent
   `saveLeadMeta` from `lib/store.js` (only `setLeadMeta`/`setLeadMetaMany`
   exist) and key meta by email instead of lead id. Every write 500s. Dead code
   today. *(MEASURED)*
2. Mail path never excludes existing customers/paid/claimed — only suppression.
   *(MEASURED in code)*
3. `api/find.js`: no fetch timeout, no daily cap, no storage dedupe. *(MEASURED)*
4. `find_places.py`/`find.py` dead-but-present; only `pull.py`'s docstring
   marks them superseded. *(DERIVED)*
5. `cron-mail` (the riskiest money path) has **zero test coverage**. *(MEASURED)*

## Test Inventory (existing)

**MEASURED coverage:** web-presence classify/segment/hookLine
(`api.mjs:629-676`), laser play-scoring + simulator separation (`laser.mjs`),
funnel stage guards (`funnel.mjs`), scorecard math + exactly-once cron
(`scorecard.mjs`, `scorecard-cron.mjs`), suppression end-to-end incl. every
outbound path blocked before spend (`suppression.mjs`), claim-followup full
lifecycle incl. cron auth matrix (`claim-followup.mjs`), bulk-draft idempotency
(`api.mjs:421-430`), draft→publish→claim lifecycle (`api.mjs:440-477`),
ensureCustomerSite branches (`autonomy-seed.mjs`), seedSite no-invention
(`site-seed.mjs`).

**UNMEASURED:** `api/find.js` handler itself (pagination/auth/error paths),
`admin 'seed'` replace semantics, cron-mail auth + autopilot economics,
`api/agent.js`, `api/switch-brain.js`, rep endpoints, production `ks:leads`
shape/volume, whether the committed token default is live.

---

## Bottom Line

The outbound half of the machine is disciplined (gated, capped,
suppression-wired, heavily tested); the prospecting half is entirely manual and
stateless, with no identity, no score, no ranking, and no durable candidate
record — but also zero risk of accidental contact, because discovery is fully
decoupled from outreach by construction.

**Classifications:** findings are MEASURED (code-read) unless labeled DERIVED or
UNMEASURED above. No live Stripe events, no emails, no postcards, no bulk
discovery calls were made during this audit.
