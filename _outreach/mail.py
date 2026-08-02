#!/usr/bin/env python3
"""
KILLSWITCH mail runner — finder -> Lob postcard.

Reads _outreach/leads.csv (from find.py), keeps the mailable ones (full US
address), builds a 6x9 postcard from the Outbound Playbook personalized by trade,
and sends it via Lob. Marks each lead 'mailed' in the CSV so nothing double-sends.

SAFE BY DEFAULT: with no flags it DRY-RUNS. It writes a visual preview of the
first postcard, prints the plan and a cost estimate, and touches nobody.

  python mail.py                 # dry run: preview + plan, sends nothing
  python mail.py --send 5        # actually mail 5 (real postage) via Lob
  python mail.py --send 5 --trade dentist   # only that trade

Env needed to actually --send:
  LOB_API_KEY   (the one already used for Homestead)
  KS_FROM_NAME, KS_FROM_LINE1, KS_FROM_CITY, KS_FROM_STATE, KS_FROM_ZIP
  (your real return address — Lob requires a valid from address)
"""
import csv, os, sys, base64, json, urllib.parse, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
LEADS = os.path.join(HERE, "leads.csv")
SIZE = "6x9"
EST_PER_CARD = 0.94  # rough Lob 6x9 all-in; tune to your Lob pricing

PHONE = os.environ.get("KS_PHONE", "").strip()

# trade -> clean plural for the playbook's "Built for ___." line on the back
TRADE_PLURAL = {
    "salon/barber": "salons and barbershops", "nails/beauty": "nail and beauty shops",
    "dentist": "dentists", "clinic/doctor": "clinics", "auto repair": "auto shops",
    "auto body": "auto shops", "restaurant": "restaurants", "cafe/coffee": "cafes",
    "vet": "veterinary clinics", "florist": "florists", "bakery": "bakeries",
    "gym/fitness": "gyms", "plumber": "plumbers", "electrician": "electricians",
    "roofer": "roofers", "painter": "painters", "landscaper": "landscapers",
    "pet groomer": "pet groomers",
}
DEFAULT_PLURAL = "local businesses"

def front_html():
    return """<html><head><meta charset="utf-8"><style>
    @page{margin:0}html,body{margin:0;padding:0;width:9.25in;height:6.25in}
    .card{width:9.25in;height:6.25in;background:#121214;color:#fff;font-family:Arial,Helvetica,sans-serif;
      box-sizing:border-box;padding:0.8in 0.85in;position:relative}
    .haz{position:absolute;top:0;left:0;right:0;height:0.16in;
      background:repeating-linear-gradient(-45deg,#FFC42E 0 0.22in,#161616 0.22in 0.44in)}
    h1{font-size:62px;line-height:1.02;margin:0.12in 0 0.14in;font-weight:900;letter-spacing:-1px}
    h1 .f{color:#FFC42E}
    .tag{font-size:25px;font-weight:600;color:#b6bac2;margin:0 0 0.2in}
    .own{font-size:26px;font-weight:800;color:#fff;line-height:1.32;margin:0;max-width:6.6in}
    .own b{color:#FFC42E}
    .brand{position:absolute;bottom:0.62in;left:0.85in;font-size:20px;font-weight:900;letter-spacing:2px}
    .brand .dot{color:#FF3826}
    </style></head><body><div class="card"><div class="haz"></div>
      <h1>Claim your<br><span class="f">100% Free</span> Website</h1>
      <p class="tag">The easiest, fastest, most productive decision you could make with your business to get seen and increase traffic.</p>
      <p class="own">You <b>own it</b>. No contract. Turn on only what you need.</p>
      <div class="brand">KILLSWITCHWEBSITES<span class="dot">.</span>COM</div>
    </div></body></html>"""

def back_html(lead):
    trade = TRADE_PLURAL.get(lead["trade"], DEFAULT_PLURAL)
    phone_line = (f'<div class="cta2">Or call or text {PHONE} and say "free site."</div>' if PHONE else "")
    # Copy lives in a LEFT column. The right ~4.2in is left clear for Lob's
    # address block + postal barcode (the back is the address side on a postcard).
    return f"""<html><head><meta charset="utf-8"><style>
    @page{{margin:0}}html,body{{margin:0;padding:0;width:9.25in;height:6.25in}}
    .card{{width:9.25in;height:6.25in;background:#fff;color:#15161a;
      font-family:Arial,Helvetica,sans-serif;box-sizing:border-box;padding:0.42in 0.5in}}
    .copy{{width:5.1in}}
    .h{{font-size:21px;font-weight:900;margin:0 0 8px;letter-spacing:-.2px}}
    .copy p{{font-size:14px;line-height:1.4;margin:0 0 6px}}
    .catch b{{font-weight:800}}
    .more{{font-size:13px;color:#3a3a3a;line-height:1.38;margin:0 0 6px}}
    .built{{font-size:15px;font-weight:900;margin:10px 0 7px}}
    .cta{{font-size:16px;font-weight:900;color:#0a7d3b;margin:0}}
    .cta .u{{text-decoration:underline}}
    .cta2{{font-size:13.5px;font-weight:700;color:#15161a;margin:4px 0 0}}
    </style></head><body><div class="card"><div class="copy">
      <div class="h">Here's how it works.</div>
      <p>We build you a real website. It's free. It's yours to keep. There's no contract.</p>
      <p class="catch">Later, most shops want more: showing up on Google, online booking, card payments, an AI that answers the phone at 2 a.m. Those run $19 to $29 a month each. <b>You turn on what you want. Nothing else switches on.</b></p>
      <p>That's it. The free website is how we meet you.</p>
      <p class="more">Want something bigger down the road, like an online store or a booking system? We build those too. Just ask.</p>
      <div class="built">Built for {trade}. We take a few builds a month.</div>
      <div class="cta">&rarr; <span class="u">killswitchwebsites.com/start</span>, usually same day, no call needed</div>
      {phone_line}
    </div></div></body></html>"""

def mailable(r):
    return bool(r.get("street") and r.get("state") and r.get("zip"))

def lob_send(lead, frm):
    key = os.environ.get("LOB_API_KEY", "")
    if not key:
        raise SystemExit("LOB_API_KEY not set. Set it (the Homestead key) to actually send.")
    auth = base64.b64encode((key + ":").encode()).decode()
    fields = {
        "description": f"KS free-site postcard: {lead['name']}",
        "use_type": "marketing",
        "to[name]": lead["name"][:40],
        "to[address_line1]": lead["street"],
        "to[address_city]": lead["city"],
        "to[address_state]": lead["state"],
        "to[address_zip]": lead["zip"],
        "from[name]": frm["name"], "from[address_line1]": frm["line1"],
        "from[address_city]": frm["city"], "from[address_state]": frm["state"], "from[address_zip]": frm["zip"],
        "front": front_html(), "back": back_html(lead), "size": SIZE,
    }
    data = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request("https://api.lob.com/v1/postcards", data=data,
                                 headers={"Authorization": "Basic " + auth})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        msg, code = f"HTTP {e.code}", None
        try:
            err = (json.loads(e.read().decode()).get("error") or {})
            msg = err.get("message", msg); code = err.get("code")
        except Exception:
            pass
        return {"error": msg, "code": code}

def main():
    args = sys.argv[1:]
    send_n = 0
    trade_filter = None
    if "--send" in args:
        i = args.index("--send")
        send_n = int(args[i + 1]) if i + 1 < len(args) and args[i + 1].isdigit() else 999999
    if "--trade" in args:
        trade_filter = args[args.index("--trade") + 1]

    rows = list(csv.DictReader(open(LEADS, encoding="utf-8")))
    targets = [r for r in rows if r.get("status") != "mailed" and mailable(r)
               and (not trade_filter or r["trade"] == trade_filter)]

    print(f"leads total: {len(rows)}  |  mailable & not-yet-mailed: {len(targets)}"
          + (f"  |  trade={trade_filter}" if trade_filter else ""))
    if not targets:
        print("nothing to mail."); return

    # always write a visual preview of the first target
    with open(os.path.join(HERE, "preview-front.html"), "w", encoding="utf-8") as f: f.write(front_html())
    with open(os.path.join(HERE, "preview-back.html"), "w", encoding="utf-8") as f: f.write(back_html(targets[0]))
    print(f"preview written: _outreach/preview-front.html + preview-back.html  (first target: {targets[0]['name']})")

    if not send_n:
        est = len(targets) * EST_PER_CARD
        print(f"\nDRY RUN. Nothing was mailed.")
        print(f"If you --send all {len(targets)}, rough cost ~ ${est:,.2f} at ${EST_PER_CARD}/card.")
        print("Open the two preview files in a browser to approve the design, then run:  python mail.py --send 5")
        return

    frm = {k: os.environ.get("KS_FROM_" + k.upper(), "") for k in ("name", "line1", "city", "state", "zip")}
    if not all(frm.values()):
        raise SystemExit("Set KS_FROM_NAME/LINE1/CITY/STATE/ZIP (your return address) to --send.")

    is_test = os.environ.get("LOB_API_KEY", "").startswith("test_")
    if is_test:
        print("[TEST KEY] test mode: validates the flow, prints/charges nothing, and will NOT consume any leads.")
    sent = 0; attempts = 0; bounced = 0
    for r in rows:
        if attempts >= send_n: break
        if r.get("status") in ("mailed", "bad_address") or not mailable(r): continue
        if trade_filter and r["trade"] != trade_filter: continue
        attempts += 1
        res = lob_send(r, frm)
        if res.get("id"):
            sent += 1
            print(f"  {'[test] ' if is_test else 'mailed '}[{r['trade']}] {r['name']}  -> {res['id']}")
            if not is_test:
                r["status"] = "mailed"; r["lob_id"] = res["id"]
        else:
            if res.get("code") == "failed_deliverability_strictness":
                bounced += 1
                if not is_test: r["status"] = "bad_address"
                print(f"  undeliverable address, skipped: {r['name']}")
            else:
                print(f"  FAILED {r['name']}: {res.get('error')}")
    print(f"\nattempted {attempts}: {sent} ok, {bounced} bad-address, {attempts - sent - bounced} other error(s)")

    if is_test:
        print(f"\n[TEST KEY] {sent} postcard(s) created in Lob's test environment. Nothing printed, nothing charged, "
              f"and leads.csv was left untouched, so these still get a real card when you run with your live key.")
        return

    # persist status (add lob_id column) — live sends only
    fields = ["trade", "name", "phone", "street", "city", "state", "zip", "email", "status", "lob_id"]
    with open(LEADS, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields); w.writeheader()
        for r in rows: w.writerow({k: r.get(k, "") for k in fields})
    print(f"\nmailed {sent} postcard(s). leads.csv updated.")

if __name__ == "__main__":
    main()
