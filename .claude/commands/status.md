---
description: Health board for this site — repo state + deployment + open ledger items (Layer 1, $0)
allowed-tools: Bash, Read
---

Produce a one-screen health board for THIS project. Deterministic, no changes.

1. Repo state: branch, `git status -s`, ahead/behind origin.
2. Deployment: this site deploys via the Vercel CLI (not git-connected), so report the last known deploy from `.vercel/` or the connector; note that a git push does NOT deploy.
3. Ledger: read `.claude/operator-ledger.json`; summarize open_requests, built, pending_decisions.

Format as a compact table. Do not push, deploy, or edit.
