---
description: Review a page/module/diff and return ranked findings — no edits (Layer 2, metered)
allowed-tools: Bash, Read, Grep, Glob
argument-hint: "<target>"
---

METERED command (spends tokens). Review `$ARGUMENTS`, return findings only.

1. Locate the target (a page, a JS module, an `api/` handler, or the current `git diff`).
2. Review for: correctness bugs, broken links/asset paths, unsafe input handling, secrets committed in the tree, weak sales-page conversion copy, accessibility gaps.
3. Return findings ranked most-severe first: file:line, one-sentence defect, concrete failure scenario. Mark CONFIRMED or PLAUSIBLE.

Apply nothing. Log actionable items to the ledger. Respect any `*_MAX_TOKENS` / `*_DAILY_CAP` cap.
