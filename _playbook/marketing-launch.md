# Killswitch marketing launch

Status date: September 4, 2026

## Operating objective

Acquire local-service businesses that need a credible website, deliver the free P0 site automatically, and convert qualified owners into optional paid modules. Optimize for completed, valid signups and activated customers—not pageviews.

## Current baseline

- Google Search Console domain ownership: verified.
- `sitemap.xml`: submitted and successful; 217 URLs discovered.
- `sitemap-sites.xml`: submitted and successful; one claimed customer site discovered at submission.
- Google index: 203 pages indexed; 22 not indexed as of Google's August 27 report.
- Search performance visible at launch: 119 impressions, 2 clicks, 1.7% CTR, average position 30.1.
- Vercel Web Analytics and conversion events: active.
- Campaign attribution: source, medium, campaign, content, term, landing page, referring host, and supported ad click IDs attach to completed signups.
- Paid media: not active. A budget and stop-loss must be approved before launch.

## First market

Start with Kansas City metro and these trades, in this order:

1. Auto repair
2. Plumbers
3. Electricians
4. HVAC
5. Roofers

The first offer is always: **A real business website, free and yours to keep.** Paid modules are optional and disclosed before signup.

## Channel sequence

### 1. Organic Google — active

- Review Search Console every Monday.
- Prioritize pages already receiving impressions before creating more location pages.
- Improve title and opening copy for queries around “website for trades,” “website for electricians,” and similar commercial terms.
- Inspect the 13 “discovered, currently not indexed” URLs before producing additional programmatic pages.
- Keep unclaimed customer sites `noindex`; only claimed, published sites enter the customer sitemap.
- Request indexing only after a material content improvement, never as a daily bulk action.

### 2. Google Search Ads — budget gate

Recommended pilot: $20/day for 30 days, Kansas City metro only. Do not enable Display, Performance Max, Search Partners, broad match, or automatic expansion during the pilot.

Campaign: `google-search-kc-free-site-v1`

Ad groups:

- `auto-repair-website`
- `plumber-website`
- `electrician-website`
- `hvac-website`
- `roofer-website`

Start with exact and phrase match commercial-intent terms. Add negatives for jobs, employment, templates, courses, school, DIY, download, hosting login, and free plumbing/electrical service. Send each trade to its matching Kansas City landing page.

Primary conversion: successful `/api/inbound` signup. Secondary conversions: qualified phone click and booked consultation. Do not optimize bidding against pageviews.

Stop-loss rules:

- Pause a keyword after 40 clicks without a valid signup.
- Pause an ad group when spend exceeds three times the target cost per valid signup without a conversion.
- Never increase a campaign budget by more than 20% in a 72-hour period.
- Exclude fraudulent, duplicate, unreachable, and out-of-market signups from the qualified metric.

### 3. Microsoft/Bing — account connection required

- Sign in to Bing Webmaster Tools and import the verified Google Search Console property.
- Submit both sitemaps and run one site scan.
- Consider Microsoft Search Ads only after the Google pilot produces a repeatable qualified-signup cost.

### 4. Direct outreach — consent and suppression required

- Continue personalized postcards and owner-requested follow-ups.
- Every email identifies Killswitch and includes an opt-out path.
- Do not automate cold SMS or prerecorded/AI calls without documented consent and a legal review of the target jurisdiction.
- Suppression requests are permanent and apply across every channel.

### 5. Referral loop

- Trigger a referral request after the customer's site is claimed and a service-completion event exists.
- Give the referrer a simple tracked link; do not create cash rewards until terms, fraud controls, and tax handling are documented.

## Campaign naming and links

Use lowercase kebab-case. Never reuse one campaign name for a materially different audience or offer.

```text
utm_source=google|bing|linkedin|facebook|email|postcard|referral
utm_medium=cpc|organic|social|email|direct-mail|referral
utm_campaign=<market>-<offer>-<version>
utm_content=<trade>-<creative>
utm_term=<keyword>  # paid search only
```

Example:

```text
https://killswitchwebsites.com/free-website-for-plumbers-in-kansas-city?utm_source=google&utm_medium=cpc&utm_campaign=kc-free-site-v1&utm_content=plumber-proof
```

## Weekly operating scorecard

Record these every Monday for the previous complete week:

- Search impressions, clicks, CTR, and average position
- Human visits and landing pages
- Valid signups by source, medium, campaign, trade, and city
- Signup-to-claimed-site rate
- Claimed-site-to-paid-module rate
- Spend, cost per valid signup, and cost per activated customer
- Calls, bookings, suppression requests, refunds, and disputes
- Failed webhooks, stuck onboarding steps, and dead-letter count

The campaign winner is the channel with the best cost per activated customer after fulfillment cost—not the most leads.

## Launch gates

- [x] Search Console domain verified
- [x] Main sitemap successful
- [x] Customer sitemap successful
- [x] Conversion events active
- [x] First-party campaign attribution implemented
- [ ] Google Ads account and conversion action connected
- [ ] Paid-search budget approved
- [ ] Bing Webmaster Tools account connected
- [x] Durable customer lifecycle and event ledger implemented
- [x] Customer self-service connection center implemented for Google, booking, and payments
- [x] Service-completion event connected to a real fulfillment action
- [ ] Cross-channel suppression list implemented
- [ ] Weekly scorecard owner and review time assigned
