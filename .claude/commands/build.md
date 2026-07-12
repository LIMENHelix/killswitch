---
description: Implement a scoped change; leave it as an uncommitted diff — never auto-deployed (Layer 2, metered)
allowed-tools: Bash, Read, Grep, Glob, Edit, Write
argument-hint: "<spec>"
---

METERED command. Implement `$ARGUMENTS` under propose→approve→apply.

1. Read the relevant code first; confirm scope. If ambiguous or wide (>~10 files), return a plan instead of editing.
2. Make the change in the working tree. Match surrounding style.
3. Run `/verify` on what changed. STOP at an uncommitted diff. Summarize what changed and why.

Boundaries:
- Never commit, push, or run the Vercel CLI deploy in this command; `/ship` handles that behind confirm.
- Use plain hyphens, not em/en dashes. Append the built item to the ledger (deployed:false).
