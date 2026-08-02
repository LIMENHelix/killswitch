#!/usr/bin/env python3
"""
Killswitch Websites lead puller — calls the server-side Places finder (/api/find, where
the Sensitive GOOGLE_PLACES_API_KEY lives) for each trade x city, keeps the
no-website businesses it returns, and merges them into leads.csv, preserving any
'mailed'/'bad_address' status. Same CSV format find.py/mail.py use.

Run:   python pull.py                          # default KC-metro cities
       KS_CITIES="Dallas, TX;Austin, TX" python pull.py
Env:   SWITCH_TOKEN (defaults to the known desk token), KS_BASE (site url),
       KS_LEADS_OUT (write somewhere other than leads.csv, for testing)
"""
import os, csv, json, time, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
LEADS = os.environ.get("KS_LEADS_OUT") or os.path.join(HERE, "leads.csv")
BASE = os.environ.get("KS_BASE", "https://killswitchwebsites.com").rstrip("/")
TOKEN = os.environ.get("SWITCH_TOKEN", "sw_kcbrain_7Q2f9x")

TRADES = ["plumber", "electrician", "hvac", "roofer", "landscaper", "painter",
          "salon/barber", "nails/beauty", "dentist", "clinic/doctor", "auto repair",
          "restaurant", "cafe/coffee", "vet", "cleaning", "pet groomer", "florist",
          "bakery", "gym/fitness"]
CITIES = [c.strip() for c in os.environ.get(
    "KS_CITIES",
    "Overland Park, KS;Kansas City, MO;Olathe, KS;Lenexa, KS;Lees Summit, MO;Independence, MO;Shawnee, KS;Leawood, KS"
).split(";") if c.strip()]

def call(trade, city):
    data = json.dumps({"token": TOKEN, "trade": trade, "city": city}).encode()
    req = urllib.request.Request(BASE + "/api/find", data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=70) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code}: " + e.read().decode()[:160]}
    except Exception as e:
        return {"error": str(e)}

FIELDS = ["trade", "name", "phone", "street", "city", "state", "zip", "email", "status", "lob_id"]

def main():
    # start from the EXISTING list so new cities ADD to it (never overwrite)
    rows = {}
    if os.path.exists(LEADS):
        for r in csv.DictReader(open(LEADS, encoding="utf-8")):
            rows[(r["name"].lower().strip(), r.get("zip", ""))] = {k: r.get(k, "") for k in FIELDS}
    existing = len(rows)
    print(f"existing leads: {existing}; adding {len(CITIES)} cities")

    for city in CITIES:
        got = 0
        for trade in TRADES:
            d = call(trade, city)
            if d.get("error"):
                print(f"  [{city} / {trade}] error: {d['error']}"); continue
            for L in d.get("leads", []):
                key = (L["name"].lower(), L.get("zip", ""))
                if key in rows: continue
                rows[key] = {"trade": L["trade"], "name": L["name"], "phone": L.get("phone", ""),
                             "street": L.get("street", ""), "city": L.get("city", ""),
                             "state": L.get("state", ""), "zip": L.get("zip", ""),
                             "email": "", "status": "new", "lob_id": ""}
                got += 1
            time.sleep(0.15)
        print(f"  {city}: +{got}  (total {len(rows)})")

    out = sorted(rows.values(), key=lambda x: (x["trade"], x["name"]))
    fields = ["trade", "name", "phone", "street", "city", "state", "zip", "email", "status", "lob_id"]
    with open(LEADS, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields); w.writeheader(); w.writerows(out)

    from collections import Counter
    by = Counter(r["trade"] for r in out)
    print(f"\nNO-WEBSITE TARGETS: {len(out)}  (+{len(out) - existing} new this run)")
    print(f"  full address (mailable): {sum(1 for r in out if r['street'] and r['state'] and r['zip'])}")
    print(f"  with a phone: {sum(1 for r in out if r['phone'])}")
    print("  by trade:", dict(by.most_common()))
    print(f"wrote {LEADS}")

if __name__ == "__main__":
    main()
