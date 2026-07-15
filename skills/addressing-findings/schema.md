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

**GitHub PR review thread** — from the GraphQL `reviewThreads` gather (→ [github.md](github.md),
"Gather PR comments"): `title` = a short summary of the thread's first comment, `location` =
`<path>:<line>`, `detail` = the first comment's `body`, `thread_id` = the thread node `id` (used to
resolve the thread in step 8; reply uses `comments[0].databaseId`), `severity` = best estimate,
`source` = `github-pr`. Skip threads where `isResolved` or `isOutdated` is true.

## Triage ledger

A persisted artifact (e.g. `triage-ledger.json` next to the plan) — one entry per finding keyed
by `stable_id` with its final verdict + one-line reason. Read it at the start of a re-run so
already-`reject`/`defer`/`needs-decision` findings are carried, not re-litigated, and so the
re-review loop can tell a recurring finding from a new one.

## Review-ledger record

A **different** artifact from the triage ledger above — the shared contract between the `review`
workflow and this fix loop. The triage ledger is this skill's, keyed by `stable_id`; the
review-ledger record is the engine's per-run JSON, keyed by `fp`. Don't conflate them.

Path/shape: `~/.craft/runs/<ts>-workflow-review.json`, keyed by `project + branch`, with top-level
`branch` / `head` / `round` plus a `ledger` array of:

```
{
  fp,           // engine fingerprint — the join key this fix loop matches on
  file, line, symbol,
  severity, tier,
  disposition,  // open | closed | rejected | justified | deferred
  source, ruleId, title, why,
}
```

**Two writer roles.** The `review` engine writes the findings + `tier` (and may auto-set `closed`
when it later confirms a fix); this fix-loop skill writes the human-sourced dispositions
`rejected` / `justified` / `deferred` / `closed` (→ SKILL.md, "Writing dispositions to the review
ledger"). Match a fix-loop finding to a ledger entry by `fp` when present, else by
`file` + `ruleId` + a title match.

`justified` has no triage-verdict source — unlike `rejected` (← `reject`) and `deferred`
(← `defer`), it is set **only here**, when a finding is kept-with-justification in the PR body
rather than fixed.
