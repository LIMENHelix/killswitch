---
description: Commit the working tree, then (with explicit confirm) deploy via the Vercel CLI (outward, double-gated)
allowed-tools: Bash, Read
argument-hint: "[--deploy]"
---

OUTWARD/IRREVERSIBLE. This site is NOT git-connected: a git push does NOT deploy. Production goes live only through the manual Vercel CLI deploy.

1. Show `git status` and what would ship.
2. Stage into LOGICAL commits, one clear message each. End every message with:
   `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
   Plain hyphens, no em/en dashes.
3. Push to the private repo (safe: it does not deploy).
4. STOP. Deploy to production ONLY if the operator passed `--deploy` AND confirms in this turn, then run the Vercel CLI deploy and mark shipped items deployed:true.

Never deploy on ambiguity. Never make the repo public.
