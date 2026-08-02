#!/usr/bin/env python3
"""
Pull the full lead set from the live store (source of truth), clean it, then
write leads.csv AND re-seed the store with the cleaned set.

Rule: strip junk framing chars from names; drop only rows with no real name
(< 2 letters) or exact (trade,name,zip) duplicates. KEEP no-address rows, they
are still callable; the mail flow already skips anything un-mailable.

  python clean_and_reseed.py
"""
import os, csv, re, json, hashlib, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
LEADS = os.path.join(HERE, "leads.csv")
BASE = os.environ.get("KS_BASE", "https://killswitchwebsites.com").rstrip("/")
TOKEN = os.environ.get("ADMIN_KEY") or os.environ.get("SWITCH_TOKEN", "sw_kcbrain_7Q2f9x")
COLS = ["trade", "name", "phone", "street", "city", "state", "zip", "email", "status", "lob_id"]

def api(payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(BASE + "/api/admin", data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as resp:
        return json.loads(resp.read().decode())

def clean_name(n):
    n = (n or "").strip().strip("*.• \t\"'`-")
    return re.sub(r"\s+", " ", n).strip()

live = api({"action": "list", "token": TOKEN}).get("leads", [])
print(f"pulled {len(live)} from store")

kept, dropped, seen = [], 0, set()
for r in live:
    name = clean_name(r.get("name"))
    if len(re.findall(r"[A-Za-z]", name)) < 2:
        dropped += 1; continue
    key = (r.get("trade", ""), name.lower(), (r.get("zip") or "").strip())
    if key in seen:
        dropped += 1; continue
    seen.add(key)
    r["name"] = name
    r.setdefault("notes", "")
    r["id"] = hashlib.md5(f"{r.get('trade','')}|{name}|{r.get('zip','')}".encode()).hexdigest()[:12]
    kept.append(r)

# write clean leads.csv (canonical columns only)
with open(LEADS, "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=COLS, extrasaction="ignore")
    w.writeheader()
    w.writerows(kept)

res = api({"action": "seed", "token": TOKEN, "leads": kept})
print(f"kept {len(kept)}  dropped {dropped} (junk name / dup)  |  re-seed: {res}")
