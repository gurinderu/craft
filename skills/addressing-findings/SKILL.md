---
name: addressing-findings
description: >-
  Systematic fix loop for review findings — gather findings from craft review agents / rust-audit reports and GitHub PR comments, normalize to one schema, triage each against the code (accept/reject/defer/needs-decision/conflict), order them, fix (delegating how-to-fix to topic skills), verify each, re-review until green, and close the loop on GitHub. The generic feedback discipline lives in superpowers:receiving-code-review; this owns the craft-flavoured, Rust-aware process. Use after a review or audit produces findings, when working through PR comments, or when deciding what to fix first. Triggers: address review comments, fix the findings, work through the review, triage findings, PR comments, act on the verdict, what to fix first, resolve review threads, rust-audit report.
---

# Addressing Findings

The fix counterpart to `rust-review`: take a set of review findings and work them to green —
gather, normalize, triage, order, fix, verify, re-review, close the loop. The generic feedback
discipline (don't implement a wrong suggestion, no performative agreement, evidence before
"done") lives in `superpowers:receiving-code-review` and `superpowers:verification-before-completion`;
this skill owns the concrete, Rust-aware process and points at the topic skills for *how* to fix
each thing.

## When to use

- After a review / `rust-audit` produces findings, or you're working through PR comments.
- Deciding what to fix first and proving each fix landed.
- **Not** for *doing* the review (→ `rust-review`) or *running* the agents (→ `rust-audit`).

## The fix loop

`⫲` marks a step that **fans out across subagents** (→ "Parallelism via subagents").

```
1. Gather  ⫲ — collect findings from both sources, one subagent per source in parallel:
               • craft: a rust-reviewer verdict / a rust-audit report
               • GitHub: gh pr view / gh api → inline thread comments     (→ github.md)
2. Normalize — to the unified schema; tag source; compute stable_id        (→ schema.md)
3. Triage  ⫲ — per finding, validated against a pinned ref, one subagent per finding:
               accept / reject / defer / needs-decision / conflict (+ reasoning)
               (generic feedback discipline → superpowers:receiving-code-review)
4. Order     — accepted only: blocking → simple → complex; group by file to cut churn
               (the grouping is what makes step 5 parallelisable — independent groups)
5. Fix     ⫲ — independent file-groups fixed concurrently, one subagent per group
               (superpowers:subagent-driven-development; worktree isolation when groups
               could touch shared files). Within a group, serial. "How to fix" → topic
               skills; a bug → regression test first, RED→GREEN                (→ rust.md)
6. Verify    — per fix: the rust-review "what proves what" proof table         (→ rust.md)
               (+ superpowers:verification-before-completion)
7. Re-review ⫲ — re-dispatch the review agents in parallel (as rust-audit does); new
               findings re-enter the loop; the ledger dedups; repeat until green (→ rust.md)
8. Close loop— (GitHub) draft replies (what was fixed / why rejected + commit), post &
               resolve ONLY after explicit user OK; map reply→thread via thread_id (→ github.md)
```

**Scaling:** small batch → steps 2–4 inline. Large batch (a fat `rust-audit` report, a
many-comment PR) → dispatch the `triage-findings` workflow, apply its plan via
`superpowers:executing-plans`, then run the re-review loop.

## Triage outcomes

Validate each finding against the code (pinned to the ref it was generated against), then:

| Verdict | Meaning | Where it goes |
|---|---|---|
| `accept` | real, in scope | into the plan |
| `reject` | wrong / not a real problem | ledger + drafted pushback (→ `superpowers:receiving-code-review`) |
| `defer` | valid but out of scope now | ledger (stays deferred across runs) |
| `needs-decision` | valid but needs a product/spec call, **or** has no resolvable location | → `specs` |
| `conflict` | contradicts another finding | both surfaced for a human; never silently pick one |

**Locationless findings** (file- or PR-level comments) get an explicit lane: resolve a concrete
location during triage, else route to `needs-decision` — never drop them silently.

## Stable id & the triage ledger

Every finding gets a **stable id** = `source::location::title` (a composite key — deterministic,
readable). A **triage ledger** records the verdict + reason for each finding keyed by stable id.
This one mechanism gives: **idempotent re-runs** (already-`reject`/`defer`/`needs-decision`
findings aren't re-litigated), **re-review identity** (tell "same finding" from "new" so "loop
until green" measures progress, not churn), and **deferred tracking** (deferred findings stay
visible). Schema details → [schema.md](schema.md).

## Parallelism via subagents

Fanning out independent work is owned by `superpowers:dispatching-parallel-agents` (ad-hoc
fan-out) and `superpowers:subagent-driven-development` (independent plan tasks) — cite them, don't
restate. Where each applies:

- **Gather (1)** — independent sources → one subagent per source.
- **Triage (3)** — each finding judged independently → one subagent per finding (the core
  fan-out). The dedup/conflict/order step afterwards needs all results together, so it does
  **not** parallelise.
- **Fix (5)** — the plan is grouped by file so **independent groups run concurrently**, one
  subagent per group, via `superpowers:subagent-driven-development`; worktree isolation only when
  groups could touch shared files. Within a group, serial.
- **Re-review (7)** — review agents run in parallel, as `rust-audit` orchestrates them.

## Rust wiring

Which agents to re-dispatch, the fix-to-skill routing, and the "what proves what" proof table →
[rust.md](rust.md).

## Closing the loop on GitHub

Reading PR threads, and drafting/posting/resolving replies (only after explicit user OK) →
[github.md](github.md).

## Boundaries

- *How* to fix a specific problem → topic skills (`rust-errors`, `rust-ownership`,
  `rust-concurrency`, `rust-security`, …).
- *How* to write the missing test → `rust-testing`; the RED→GREEN mechanic →
  `superpowers:test-driven-development` (cite, don't restate).
- Generic feedback discipline → `superpowers:receiving-code-review`; proof →
  `superpowers:verification-before-completion`; plan formalization/execution →
  `superpowers:writing-plans` / `executing-plans`; parallel fan-out →
  `superpowers:dispatching-parallel-agents` / `subagent-driven-development`.
- Findings needing product/spec input → `specs`.
- This skill does **not** rewrite for the reviewer and does **not** duplicate the `rust-review`
  rubric or its proof table — it cites them.
