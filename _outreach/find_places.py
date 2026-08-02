#!/usr/bin/env python3
"""
Killswitch Websites lead finder — Google Places (New) edition.

Far better coverage and USPS-clean addresses than OSM, plus phone numbers.
For each trade x city it runs a Places Text Search, keeps businesses with NO
website, parses a clean street/city/state/zip, and merges into leads.csv (same
format find.py/mail.py use), preserving any 'mailed'/'bad_address' status.

Key: reads the first of these env vars that is set:
  GOOGLE_PLACES_KEY, GOOGLE_PLACES_API_KEY, GOOGLE_MAPS_API_KEY, PLACES_API_KEY, GOOGLE_API_KEY
Enable "Places API (New)" on that key in Google Cloud. Restrict it to Places API.

Run:   python find_places.py                 # default KC-metro cities, all trades
       KS_CITIES="Dallas, TX;Austin, TX" python find_places.py
Cost:  ~1 request per trade per city (a few cents each); the $200/mo Google
       credit covers thousands. Query only the cities you actually want.
"""
import os, sys, csv, json, time, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
LEADS = os.environ.get("KS_LEADS_OUT") or os.path.join(HERE, "leads.csv")

KEY = ""
for n in ("GOOGLE_PLACES_KEY", "GOOGLE_PLACES_API_KEY", "GOOGLE_MAPS_API_KEY", "PLACES_API_KEY", "GOOGLE_API_KEY"):
    if os.environ.get(n):
        KEY = os.environ[n]; KEY_NAME = n; break

# trade label (matches mail.py) -> search noun
TRADES = {
    "plumber": "plumbers", "electrician": "electricians", "hvac": "hvac companies",
    "roofer": "roofers", "landscaper": "landscapers", "painter": "painters",
    "salon/barber": "hair salons", "nails/beauty": "nail salons",
    "dentist": "dentists", "clinic/doctor": "medical clinics",
    "auto repair": "auto repair shops", "restaurant": "restaurants",
    "cafe/coffee": "coffee shops", "vet": "veterinary clinics",
    "cleaning": "cleaning services", "pet groomer": "pet grooming",
    "florist": "florists", "bakery": "bakeries", "gym/fitness": "gyms",
}
CITIES = [c.strip() for c in os.environ.get(
    "KS_CITIES",
    "Overland Park, KS;Kansas City, MO;Olathe, KS;Lenexa, KS;Lees Summit, MO;Independence, MO;Shawnee, KS;Leawood, KS"
).split(";") if c.strip()]

FIELDMASK = ("places.id,places.displayName,places.formattedAddress,places.addressComponents,"
             "places.nationalPhoneNumber,places.websiteUri")

def text_search(query, page_token=None):
    body = {"pageToken": page_token} if page_token else {"textQuery": query, "pageSize": 20}
    req = urllib.request.Request(
        "https://places.googleapis.com/v1/places:searchText",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "X-Goog-Api-Key": KEY, "X-Goog-FieldMask": FIELDMASK},
    )
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:400]
        raise SystemExit(f"Places API error {e.code}: {detail}\n"
                         f"(If 403 PERMISSION_DENIED, enable 'Places API (New)' on the key.)")

def parse_addr(components):
    g = {}
    for c in components or []:
        t = c.get("types", [])
        if "street_number" in t: g["num"] = c.get("longText", "")
        elif "route" in t: g["route"] = c.get("longText", "")
        elif "locality" in t: g["city"] = c.get("longText", "")
        elif "postal_town" in t and "city" not in g: g["city"] = c.get("longText", "")
        elif "administrative_area_level_1" in t: g["state"] = c.get("shortText", "")
        elif "postal_code" in t: g["zip"] = c.get("longText", "")
    street = " ".join(x for x in [g.get("num", ""), g.get("route", "")] if x).strip()
    return street, g.get("city", ""), g.get("state", ""), g.get("zip", "")

def main():
    if not KEY:
        raise SystemExit("No Google Places key found in env. Set GOOGLE_PLACES_KEY (or run: setx GOOGLE_PLACES_KEY \"...\").")
    print(f"using key from {KEY_NAME}; cities: {len(CITIES)}, trades: {len(TRADES)}")

    # preserve existing statuses
    prior = {}
    if os.path.exists(LEADS):
        for r in csv.DictReader(open(LEADS, encoding="utf-8")):
            prior[(r["name"].lower().strip(), r.get("zip", ""))] = (r.get("status", "new"), r.get("lob_id", ""))

    rows = {}
    for trade, noun in TRADES.items():
        for city in CITIES:
            q = f"{noun} in {city}"
            token, pages = None, 0
            while pages < 2:
                d = text_search(q, token)
                for p in d.get("places", []):
                    if p.get("websiteUri"):
                        continue  # has a website, skip
                    name = (p.get("displayName") or {}).get("text", "").strip()
                    if not name:
                        continue
                    street, ccity, state, zc = parse_addr(p.get("addressComponents"))
                    key = (name.lower(), zc)
                    if key in rows:
                        continue
                    st, lob = prior.get((name.lower(), zc), ("new", ""))
                    rows[key] = {
                        "trade": trade, "name": name,
                        "phone": p.get("nationalPhoneNumber", ""),
                        "street": street, "city": ccity, "state": state, "zip": zc,
                        "email": "", "status": st, "lob_id": lob,
                    }
                token = d.get("nextPageToken")
                pages += 1
                if not token:
                    break
                time.sleep(2)  # New API needs a moment before the page token is valid
            time.sleep(0.2)
        print(f"  {trade}: running total {len(rows)}")

    out = list(rows.values())
    out.sort(key=lambda x: (x["trade"], x["name"]))
    fields = ["trade", "name", "phone", "street", "city", "state", "zip", "email", "status", "lob_id"]
    with open(LEADS, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields); w.writeheader(); w.writerows(out)

    from collections import Counter
    by = Counter(r["trade"] for r in out)
    print(f"\nNO-WEBSITE TARGETS: {len(out)}")
    print(f"  with a full address (mailable): {sum(1 for r in out if r['street'] and r['state'] and r['zip'])}")
    print(f"  with a phone: {sum(1 for r in out if r['phone'])}")
    print("  by trade:", dict(by.most_common()))
    print(f"wrote {LEADS}")

if __name__ == "__main__":
    main()
