# KILLSWITCH — Autonomous Outbound Engine (V1)
### Tested on Killswitch first → then it becomes the product.

**What it is:** your AI sales rep. It finds Wix-refugee businesses, personalizes a
pitch to each, sends a multi-touch sequence, follows up, and books meetings on your
Calendly — hands-off. You only touch the warm replies. Run it on Killswitch's own
outreach; once it's booking *you* clients, it's the product you sell to others.

**The honest scope:** it autonomously does **find → personalize → send → follow up →
qualify → book.** *You* still close the call. That's "autonomous sales development,"
and it's real and sellable today. Don't promise autonomous *closing* — that's the part
that gets refunds.

---

## THE STACK
1. **Sending domain — NOT killswitch.domains.** Buy a throwaway like `getkillswitchkc.com` (~$12). Protects your main domain's reputation.
2. **Cold-email tool:** **Instantly.ai** or **Smartlead** (~$37/mo). Add 1–2 mailboxes on the new domain, turn on **warmup** (runs ~14 days before you send anything cold).
3. **Lead source:** **Outscraper** — pulls KC businesses by category *with emails + website URL* straight from Google Maps. Export CSV.
4. **AI personalization:** the tool's built-in AI (or a `{{personalization}}` variable).
5. **Replies → your inbox + a Calendly link in every email.**

## SETUP (one-time, ~1–2 hrs + 14-day warmup)
1. Buy the sending domain.
2. In Instantly: add domain → create 2 mailboxes (chris@, hello@) → it walks you through SPF/DKIM/DMARC → **enable warmup → WAIT ~14 days** before real sends.
3. Outscraper: pull a list (e.g. "plumbers Kansas City", "salons Overland Park") → export CSV with **email + website** columns.
4. Clean it: keep only rows with **no website** or a **wixsite.com / squarespace.com / godaddysites.com / weebly** URL. (Sort by the website column — it's fast.)
5. Upload to Instantly as a campaign → paste the sequence below → set **30–50 sends/day per mailbox** → follow-ups ON.
6. Launch. Warm replies → you book + close.

---

## THE SEQUENCE (paste in; {{vars}} auto-fill from your list)

**Email 1 — Day 1**
Subject: `{{companyName}}'s website`
> Hi {{firstName}} — I'm Chris, I build websites for Kansas City businesses. I noticed {{companyName}} {{problem}} *(e.g. "is on a free Wix site" / "doesn't have a site yet")*.
>
> I do clean, **done-for-you** sites — live in a day, from **$149**, and you own everything. Want me to mock one up **free** so you can see what yours could look like? No pressure either way.
>
> — Chris · killswitch.domains

**Email 2 — Day 3** (replies to the same thread)
Subject: `re: {{companyName}}'s website`
> Quick follow-up — I actually sketched a rough version of what a site for {{companyName}} could look like. Want me to send it over? 2 minutes to look, costs you nothing.
> — Chris

**Email 3 — Day 6**
> Last note from me, {{firstName}} — if a clean website that's live this week (from $149) is ever useful, I'm one quick call away: [Calendly link]. Either way, best of luck with {{companyName}}.
> — Chris · Killswitch

*The "free mockup" line is your weapon — you can build a one-pager in 30 min, so for anyone who replies, actually do it and send a screenshot. That converts like nothing else.*

---

## COMPLIANCE (don't skip — this is what keeps you out of trouble)
- Every email needs a **real physical address + one-click unsubscribe** (the tool adds these).
- **B2B business addresses only.** Honor every opt-out immediately.
- Email first; **calls/texts later** carry TCPA consent rules — heavier. Start with email.
- Be honest in subject + body (CAN-SPAM). No fake "re:" tricks beyond a genuine threaded follow-up.

## V1 → PRODUCT
Once this books Killswitch clients, you have a **working engine + proof.** Package it:
> **"Killswitch AI Sales Rep — qualified meetings on autopilot. $X/mo."**
Sell it with the most powerful case study there is: *"this is the exact system that built my own company."* Lead with the upside ("a tireless rep that never sleeps, scales instantly, costs a fraction of a hire") — **not** "dodge labor laws." Same result, no landmine.

## DO THIS NOW
1. Register the sending domain.
2. Start an Instantly free trial → add mailboxes → **turn on warmup today** (clock starts).
3. While it warms (~2 wks): run the manual Maps-sweep outreach so you're landing clients *now*, not waiting on the machine.
