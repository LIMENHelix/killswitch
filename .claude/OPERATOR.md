# Operator Control Surface

On-demand command menu for this site. Any Claude Code session (local or the claude.ai
cowork environment, once GitHub is connected) drives it by the same commands. You are
the trigger; nothing fires on a clock.

## Commands

| Command | Layer | Cost | Does |
|---|---|---|---|
| `/status` | 1 | $0 | Repo + deployment + ledger health board |
| `/verify` | 1 | $0 | Build/lint/link check → DEPLOYABLE verdict |
| `/ledger [show\|add-request\|resolve\|decide]` | 1 | $0 | Read/update the tracking ledger |
| `/audit <target>` | 2 | metered | Ranked findings, no edits |
| `/build <spec>` | 2 | metered | Scoped change → uncommitted diff, never auto-deployed |
| `/decide <question>` | 2 | metered | Decision brief: options + recommendation |
| `/ship [--deploy]` | outward | deploy $ | Logical commits + push; deploy is the manual Vercel CLI step, double-confirmed |

**Cost rule:** Layer 1 is always free. Layer 2 spends only when invoked, capped by
`*_MAX_TOKENS` / `*_DAILY_CAP`. Nothing recurring, nothing unattended.

**Deploy note:** this site is CLI-deployed, NOT git-connected. A git push is safe and
does not deploy; production goes live only through the Vercel CLI, behind an explicit
confirm in `/ship`.
