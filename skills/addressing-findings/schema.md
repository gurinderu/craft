# Unified finding schema

One schema for both sources. The first four fields reuse `rust-audit`'s finding fields
(`workflows/rust-audit.js`) so a `rust-audit` report maps onto this schema **mechanically**; the
rest are what the fix side needs.

```
{
  stable_id,      // source::location::title — durable identity (dedup, ledger, idempotent re-runs)
  source,         // "rust-audit" | "rust-reviewer" | "rust-security-scanner" | "github-pr" | ...
  severity,       // Critical | High | Medium | Low | Info   (same vocabulary as rust-audit)
  title,          // short "what"
  location,       // "file:line" | "crate/module" | "PR-level" | "" (may be absent)
  detail,         // "why"
  proposed_fix,   // optional — the fix direction from the source, if any
  thread_id,      // optional — GitHub review thread id (for loop closure)
}
```

After triage each finding carries a **compact** result (kept small so the ordering/plan step
doesn't blow up on a large PR):

```
{ stable_id, verdict, reason, fix_pointer }
// verdict ∈ accept | reject | defer | needs-decision   (conflict is assigned later, when all
//   findings are visible together)
// fix_pointer = owning topic skill + one-line direction (NOT the full proof text); empty unless accept
```

## Per-source mapping

**craft agent / `rust-audit` report** — each report finding already has
`severity · title · location · detail`; copy them verbatim. `source` = `rust-audit` (or the
specific agent, e.g. `rust-reviewer`). `proposed_fix` / `thread_id` empty.

**GitHub PR inline comment** — from `gh api .../pulls/<pr>/comments`:
`title` = a short summary of the comment, `location` = `<path>:<line>` (`path` + `line`/
`original_line` from the comment), `detail` = the comment body, `thread_id` = the comment/thread
id, `severity` = best estimate, `source` = `github-pr`. Skip outdated/resolved threads.

## Triage ledger

A persisted artifact (e.g. `triage-ledger.json` next to the plan) — one entry per finding keyed
by `stable_id` with its final verdict + one-line reason. Read it at the start of a re-run so
already-`reject`/`defer`/`needs-decision` findings are carried, not re-litigated, and so the
re-review loop can tell a recurring finding from a new one.
