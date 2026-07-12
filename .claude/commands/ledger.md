---
description: Print or update the tracking ledger for this site (Layer 1, $0)
allowed-tools: Bash, Read, Edit
argument-hint: "[show | add-request <text> | resolve <id> | decide <id> <choice>]"
---

The ledger at `.claude/operator-ledger.json` persists state between on-demand runs (no daemon). Handle `$ARGUMENTS`:

- `show` (default): render open_requests, built, pending_decisions, guardrails_tripped.
- `add-request <text>`: append an open_request with a short id, status "open", today's date (from context, not Date.now).
- `resolve <id>`: mark done.
- `decide <id> <choice>`: record the choice, set awaiting_operator=false.

Only edit `.claude/operator-ledger.json`. Never touch code, commit, or deploy.
