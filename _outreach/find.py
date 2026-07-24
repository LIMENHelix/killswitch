#!/usr/bin/env python3
"""
KILLSWITCH lead finder (DIY, free, no API key).

Pulls local businesses from OpenStreetMap (Overpass API) inside a bounding box,
keeps only the ones with NO website, and writes a CSV grouped by trade. Those
no-website businesses are the prime targets: they need exactly what we give away.

Run:  python find.py            (defaults to the KC metro bbox)
Out:  _outreach/leads.csv

Coverage note: OSM has strong data for salons, nails, dentists, auto repair,
restaurants, vets; thinner for plumbers/roofers/electricians. It gives name +
address (great for MAIL) and sometimes a phone. Email is rarely present, so the
email channel needs a separate email-finding step.
"""
import json, csv, sys, urllib.parse, urllib.request, os

# trade label -> list of OSM tag filters
TRADES = {
    "salon/barber": ['["shop"="hairdresser"]'],
    "nails/beauty": ['["shop"="beauty"]', '["shop"="nail_salon"]'],
    "dentist": ['["amenity"="dentist"]'],
    "clinic/doctor": ['["amenity"="clinic"]', '["amenity"="doctors"]'],
    "auto repair": ['["shop"="car_repair"]'],
    "restaurant": ['["amenity"="restaurant"]'],
    "cafe/coffee": ['["amenity"="cafe"]'],
    "vet": ['["amenity"="veterinary"]'],
    "florist": ['["shop"="florist"]'],
    "bakery": ['["shop"="bakery"]'],
    "gym/fitness": ['["leisure"="fitness_centre"]'],
    "plumber": ['["craft"="plumber"]'],
    "electrician": ['["craft"="electrician"]'],
    "roofer": ['["craft"="roofer"]'],
    "painter": ['["craft"="painter"]'],
    "landscaper": ['["craft"="gardener"]', '["shop"="garden_centre"]'],
    "auto body": ['["shop"="car_parts"]'],
    "pet groomer": ['["shop"="pet_grooming"]'],
}

# default bbox: KC metro (south = OP/Leawood/Lenexa, north into KCMO). (S,W,N,E)
BBOX = os.environ.get("KS_BBOX", "38.85,-94.85,39.25,-94.40")

def build_query(bbox):
    parts = []
    for label, filters in TRADES.items():
        for f in filters:
            parts.append(f'nwr{f}({bbox});')
    return "[out:json][timeout:90];(" + "".join(parts) + ");out center tags;"

def trade_of(t):
    for label, filters in TRADES.items():
        for f in filters:
            # crude: match key=value from the filter string
            kv = f.strip('[]').replace('"', '').split('=')
            if len(kv) == 2 and t.get(kv[0]) == kv[1]:
                return label
    return "other"

def main():
    bbox = sys.argv[1] if len(sys.argv) > 1 else BBOX
    q = build_query(bbox)
    url = "https://overpass-api.de/api/interpreter"
    data = urllib.parse.urlencode({"data": q}).encode()
    print(f"querying OSM for bbox {bbox} ...")
    req = urllib.request.Request(url, data=data, headers={"User-Agent": "killswitch-leadfinder/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        d = json.load(r)
    els = d.get("elements", [])

    rows = []
    seen = set()
    for e in els:
        t = e.get("tags", {})
        name = t.get("name")
        if not name:
            continue
        has_site = any(k in t for k in ("website", "contact:website", "url"))
        if has_site:
            continue
        key = name.lower().strip()
        if key in seen:
            continue
        seen.add(key)
        street = " ".join(x for x in [t.get("addr:housenumber", ""), t.get("addr:street", "")] if x).strip()
        rows.append({
            "trade": trade_of(t),
            "name": name,
            "phone": t.get("phone") or t.get("contact:phone") or "",
            "street": street,
            "city": t.get("addr:city", ""),
            "state": t.get("addr:state", ""),
            "zip": t.get("addr:postcode", ""),
            "email": t.get("email") or t.get("contact:email") or "",
            "status": "new",
        })

    rows.sort(key=lambda x: (x["trade"], x["name"]))
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "leads.csv")
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["trade", "name", "phone", "street", "city", "state", "zip", "email", "status"])
        w.writeheader()
        w.writerows(rows)

    from collections import Counter
    by = Counter(r["trade"] for r in rows)
    withaddr = sum(1 for r in rows if r["street"])
    withphone = sum(1 for r in rows if r["phone"])
    print(f"\nNO-WEBSITE TARGETS: {len(rows)}")
    print(f"  with a street address (mailable): {withaddr}")
    print(f"  with a phone: {withphone}")
    print(f"  with an email (rare): {sum(1 for r in rows if r['email'])}")
    print("  by trade:", dict(by.most_common()))
    print(f"\nwrote {out}")

if __name__ == "__main__":
    main()
