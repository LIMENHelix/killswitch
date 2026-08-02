# Killswitch Websites — Outbound Playbook v1

Source of truth for Switch (the AI sales rep) and all human outreach. The email +
SMS sequences here are encoded into the Switch brain (api/switch-brain.js). The
phone scripts, objection handling, direct mail, and operating notes are human
reference. Kept out of the public deploy via .vercelignore.

**Offer:** A real website, built by a human, free. You own it. No contract. Add-ons ($19–29/mo) only if you want them. Starter Machine = free site + Google + Booking = $38/mo.

**The strategic core:** "Free" is not a benefit, it's an *alarm*. Every owner has been burned by "free." So the whole campaign is one move: **raise the objection before they do, and answer it with the truth.** Nothing manufactures urgency or hides the money. The offer is genuinely good; the copy's only job is to get it *believed*.

**Three levers, everywhere:**
1. **Disarm** — name the catch out loud in the first 10 words.
2. **Specificity** — their trade, their town, their exact failure mode (the 7pm missed call, the "no website" Google result).
3. **Zero-risk next step** — not "book a call." *"Reply with your business name."* One-word replies convert.

---

## PART 1 — EMAIL SEQUENCE

### DAY 1 — "The Catch" (goal: get believed, not booked)

Subjects (test): `the catch, up front` / `free website. here's how we actually make money.` / `[Business] — no website? (or: that one?)` / `weird offer for a [plumber/salon/clinic] in [City]`

> Hi {{FirstName}} —
> I'm going to lead with the catch, because you're going to look for it anyway.
> We build local businesses a real website. Free. Your domain, your content, your code, handed to you on day one. No contract. If that's all you ever take from us, we shake hands and go away.
> **How we make money:** we're betting that once the site is bringing you customers, you'll *want* the parts that turn a nice site into a machine — showing up on Google, online booking, card payments, an AI that answers the phone at 2 a.m. Those are $19–29/mo each, all optional, and nothing turns on unless you turn it on.
> That's it. That's the whole model. We earn the free site back by being good enough that you choose to buy more.
> Want yours? Reply with just your business name and I'll have the site built and the link in your inbox. No call needed.
> — {{SenderName}}, Killswitch Websites · killswitchwebsites.com
> *P.S. We only take a handful of free builds at a time so each one gets done right.*

Trade swaps (replace paragraph 2):
- **Plumbers:** Half the plumbers in {{City}} are still a Facebook page and a phone number. Meanwhile the guy who *does* have a site is the one Google hands the 9 p.m. burst-pipe search to. That's the whole game, and it's the thing we fix for free.
- **Clinics:** Patients don't call to ask if you take their insurance anymore. They Google it, and if the answer isn't on a page in the first ten seconds, they book with the clinic where it was.
- **Salons / barbershops:** Your chair is either full or it's gone forever — you can't sell Tuesday 2 p.m. on Wednesday. A site with 24/7 booking sells the slot while you're mid-cut.

### DAY 3 — "Proof + The Cost of Nothing"

Subjects: `three sites you can click right now` / `you can go look at them (no mockups)` / `re: the catch`

> {{FirstName}} — fair question after my last email: does this company actually build anything, or is it a pitch deck?
> Go click them: allaccesskc.com (local guide, live chat) · recursivelove.com (resource hub, 24/7 AI helper) · limenhelix.com (our own intelligence platform).
> Live sites. Real businesses. Today.
> Here's the part to sit with: doing nothing isn't free either. Every week without a site you're paying: the customer who searched "{{trade}} near me" at 8 p.m. and got your competitor; the caller who hung up because nobody picked up; the person who couldn't tell if you were still in business and moved on. You never see those. That's what makes them expensive.
> The build costs you nothing and takes minutes. Reply with your business name and I'll start it today.
> — {{SenderName}}
> *We run the machine on ourselves first: this email found you because our own AI sales agent went looking.*

### DAY 10 — "Close the Loop" (hands them control; out-converts "just following up")

Subjects: `closing your file` / `should I stop?` / `last one from me, {{FirstName}}`

> {{FirstName}} — I've sent two. You've sent none. That's a message, and I'd rather read it right than keep pestering a busy person.
> So pick a number and hit reply. One character is a complete answer:
> **1** — Build it. Send your business name, I'll have the free site live and in your inbox, no call.
> **2** — Interested, wrong month. I'll close this out and check back in the fall.
> **3** — Not for me. I delete you from the list and you never hear from me again. No hard feelings, and I mean that.
> If it's silence, I'll assume 3 and take you off myself.
> Either way — genuinely, good luck with {{BusinessName}}. {{City}} is better with you in it.
> — {{SenderName}}, Killswitch Websites
> *P.S. If it's a "yes, but I don't believe you," that's a 1 too. Let me build it, then argue with me.*

---

## PART 2 — SMS SEQUENCE

> **Compliance, not optional:** text only businesses you have a lawful basis to contact, honor STOP instantly, identify yourself in message one, keep to business hours in their time zone. Have counsel bless the list before this ships.

- **Text 1 (Day 1):** {{FirstName}} — {{SenderName}} w/ Killswitch Websites. We build local businesses a real website, free, and you own it. Catch is we hope you'll later pay for booking/Google/etc. Optional, always. Want yours? Just send your business name. Reply STOP to opt out.
- **Text 2 (Day 3):** {{FirstName}} — no pressure, one question: when someone Googles "{{trade}} near me" in {{City}} at 8pm, do they find you or the other guy? Free site fixes that. Takes minutes. Yes?
- **Text 3 (Day 10):** {{FirstName}} — closing your file. Reply 1 = build my free site. 2 = later. 3 = never. Silence = 3 and I'll take you off myself. Either way, good luck out there.

**Reply handlers:**
- "What's the catch?" → No catch on the site — it's yours, no contract. We make money if you later add Google/booking/payments ($19–29/mo, optional). That's the whole model.
- "How much?" → Site: $0. Add-ons only if you want them. Most popular combo is $38/mo (Google + booking). You can also take just the free site and never spend a dime.
- "I already have a website." → Good. Then the free build is a free second opinion — if ours isn't better, keep yours and we walk. Costs you nothing to look.
- "I'm too busy." → That's the point. No call, no meeting. Send your business name and I'll do the rest.

---

## PART 3 — DIRECT MAIL

**Postcard (6×9 oversized). FRONT:** "We'll build your website. Free." / "And no, we're not going to hold it hostage." / Killswitch Websites · killswitchwebsites.com
**BACK:** The catch, since you're looking for it: the website is free and genuinely yours (domain, content, code, no contract). We bet you'll later want the machine around it (Google, 24/7 booking, payments, a 2 a.m. AI), $19–29/mo, nothing on unless you turn it on. That's how a free website pays for itself. Built for {{trade}}s. → killswitchwebsites.com/start (live in minutes, no call) or call/text {{Phone}} and say "free site."

**The Letter (1 page, #10 window envelope, real stamp, blue-ink signature — beats the postcard 3:1 on trades):** opens "This is a sales letter. You knew that by the second line." States the free real site you own, no contract, keep it and walk if you want. Explains the model (add-ons $19–29/mo, optional, off). "We give away the thing you'd normally pay two thousand dollars for, and bet on being good enough that you choose to pay later." Proof (allaccesskc.com, recursivelove.com). "We take a handful of builds at a time." CTA: killswitchwebsites.com/start or call and say "free site." P.S. the paper letter proves we'll do the unscalable thing.

---

## PART 4 — PHONE SCRIPTS

**Cold-call opener (the only 20 seconds that matter). Never open with "How are you today?"**
> "{{FirstName}}? Hi, my name's {{SenderName}}, I'm with a company called Killswitch Websites. I'm going to be straight with you: this is a sales call. You can hang up and I won't take it personally. Can I have thirty seconds to tell you what it is, and then you decide?"
> [pause, let them answer] "Thank you. We build local {{trade}}s a website. Free. Not a trial, not a lease, you own it, your domain, no contract. The reason we can do that is we make our money later, if you decide you want online booking, or showing up on Google, or an AI that answers the phone at 2 a.m. Those run $19–29/mo, off unless you turn them on."
> [pause] "So my question isn't 'will you buy something.' It's: do you currently have a website you're proud of?"

- **"No / it's terrible"** → "Then this is easy. I'll build you one this week for nothing, you look at it, if you hate it you delete it and we're done. What's the business name and best email?"
- **"Yes, I have one"** → "Good, most guys don't. Then a sharper question: when someone in {{City}} Googles '{{trade}} near me' right now, are you on the first page, and can they book you without calling? That's the part we fix. The site's just how we get invited."
- **"What's the catch?"** (buying signal) → "Good, you should ask. No catch on the site: yours, free, no contract, in writing. The bet is you'll want the add-ons once it's making money. If you never do, we lose the bet and you keep a free website."

**Objection handling (feel → reframe → close):**
- "I'm too busy." → "Exactly the argument for a site that answers customers when you're not free to. Takes zero of your time: business name, services, a phone number. Sixty seconds and I build it around your schedule."
- "Nothing's free." → "Right, and I won't insult you. The site's free; the hope isn't. We hope you buy add-ons later. That's the price, a shot at a second conversation. Say no and keep the site."
- "I get all my work from word of mouth." → "Best kind, and exactly why this matters: word of mouth ends in a Google search. Your best salesperson is handing leads to a search bar. Let's make sure it hands them back."
- "I tried a website, it didn't do anything." → "Because a website by itself is a business card that costs money. It does nothing until it's found and can book. That's why the site's free and the found-and-book part is the product."
- "My nephew is building me one." → "Great. Take ours as a free backup and let them race. You keep whichever brings a job first."
- "Send me some information." → "I'll do better, I'll send you a site. Same effort for me. What's the business name?"
- "I need to think about it." → "Sure, what specifically, whether it's really free or whether it'll work? [listen] Here's a way with the risk removed: I build it, you look at the real thing instead of imagining it, then you think about it."

**Voicemail (twice, 4 days apart, under 20 sec):**
- VM1: "{{FirstName}}, {{SenderName}} with Killswitch Websites, we build {{trade}}s a website for free, you own it, no contract. There's a catch and I'll tell you what it is when you call back. {{Phone}}."
- VM2: "{{FirstName}}, {{SenderName}}, Killswitch Websites, second and last call. The catch is we hope you'll buy add-ons later. That's it. Free site's yours either way. {{Phone}}."

**Inbound / warm call (free site → Starter Machine $38/mo). Deliver first; the free build IS the pitch.**
> "Your site's live and it's yours, that part's done. I don't need anything today. I do want to tell you the one thing that decides whether it makes you money or just sits there, then I'll shut up. A website nobody finds is a billboard in the desert. Two switches change that: getting found on Google, and online booking. $19 each, $38 together, month to month, cancel whenever. What's one {{job}} worth to you? [let them answer] So this pays for itself if it brings you one, and if it doesn't you turn it off and keep the site. I'll switch both on and you'll see it working by Friday, sound alright? [if hesitation] Take booking alone at $19, the one owners never regret. Google can wait."

---

## PART 5 — OPERATING NOTES

- The free build is the funnel, not a loss. Ship every free site with the upsells visible and *off* (the switch metaphor is the sales tool).
- Kill the call in the CTA. Ask is "reply with your business name," Calendly is the fallback.
- Segment lists by trade before sending. One line of trade-specific pain beats three paragraphs of generic benefit.
- Truth is the strategy. The moment the copy out-runs the truth, the "we told you the catch" mechanism dies. No invented scarcity, no fake discounts.
- Metrics: Day-1 reply rate (target 4–8% on a clean list), Day-10 "1/2/3" response rate (should beat Day 1 + 3 combined), free-site → paid add-on conversion at 30 days (the only number that pays the bills).
