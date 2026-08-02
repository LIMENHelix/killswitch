#!/usr/bin/env python3
"""
One-time (and re-runnable): push leads.csv into the hosted admin's KV store, so
the admin page at /admin can read/write it. Run after adding the KV store to
Vercel. Re-run anytime you've grown leads.csv with new cities.

  python seed_kv.py

Env: ADMIN_KEY or SWITCH_TOKEN (defaults to the known token), KS_BASE (site url).
"""
import os, csv, json, hashlib, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
LEADS = os.path.join(HERE, "leads.csv")
BASE = os.environ.get("KS_BASE", "https://killswitchwebsites.com").rstrip("/")
TOKEN = os.environ.get("ADMIN_KEY") or os.environ.get("SWITCH_TOKEN", "sw_kcbrain_7Q2f9x")

rows = []
for r in csv.DictReader(open(LEADS, encoding="utf-8")):
    r["id"] = hashlib.md5(f"{r.get('trade','')}|{r.get('name','')}|{r.get('zip','')}".encode()).hexdigest()[:12]
    r.setdefault("notes", "")
    rows.append(r)

print(f"seeding {len(rows)} leads to {BASE}/api/admin ...")
data = json.dumps({"action": "seed", "token": TOKEN, "leads": rows}).encode()
req = urllib.request.Request(BASE + "/api/admin", data=data, headers={"Content-Type": "application/json"})
try:
    with urllib.request.urlopen(req, timeout=90) as resp:
        print(resp.read().decode())
except urllib.error.HTTPError as e:
    print("error", e.code, e.read().decode()[:300])
