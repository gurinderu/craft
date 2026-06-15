# Design — `addressing-findings` skill + `triage-findings` workflow

**Date:** 2026-06-15
**Status:** Approved design, ready for implementation plan
**Author:** Nick

## Problem

`craft` has a rich **review** side — the `rust-review` skill (rubric), the
`rust-reviewer` / `rust-architecture-reviewer` / `rust-security-scanner` / `rust-miri`
agents, and the `rust-audit` workflow (synthesizes one severity-ranked report). It has
**nothing describing how to systematically work through the findings those produce** —
take a set of findings, triage them, fix them in the right order, verify each, re-review
until clean, and close the loop on the source. This design adds the symmetric **fix** side.

The generic engineering-process discipline (don't implement a wrong suggestion, no
performative agreement, evidence before "done") already lives in the `superpowers` plugin
(`receiving-code-review`, `verification-before-completion`). craft owns the **concrete,
Rust-flavoured** layer: the normalization schema, the triage outcomes, the ordering rule,
which proof command proves what, which agents to re-dispatch, and how to close GitHub
threads.

## Goals

- One **skill** that owns the fix discipline end to end (gather → normalize → triage →
  order → fix → verify → re-review → close loop), delegating generic method to
  `superpowers` and "how to fix X" to topic skills.
- One **workflow** that produces an ordered, validated **fix plan** (triage + plan only —
  no edits), symmetric to `rust-audit` being report-only.
- Works for findings from **both** sources (craft agents / `rust-audit` reports **and**
  GitHub PR inline review comments), normalized to one schema.

## Non-goals

- The workflow does **not** apply edits. Fixes are applied later, serially, via
  `superpowers:executing-plans`.
- This skill does **not** re-derive the `rust-review` rubric or rewrite for the reviewer.
- No automatic outward writes: GitHub thread replies/resolution happen only after explicit
  user approval.

## Locked decisions

| # | Decision |
|---|---|
| 1 | Findings come from **both** sources (craft agents / `rust-audit` reports **and** GitHub PR inline comments), normalized to one schema. |
| 2 | Form = a new **skill** + a new **workflow**. |
| 3 | Workflow role = **triage + plan only**, no edits (symmetric to `rust-audit`). Edits applied later via `superpowers:executing-plans`. |
| 4 | Triage **validates each finding** against the code: `accept` / `reject` / `defer` / `needs-decision` / `conflict`, with reasoning. Only `accept` enters the plan. |
| 5 | GitHub loop closure (reply + resolve threads) happens **only after explicit user approval**; the skill prepares drafts. |
| 6 | The workflow is **self-contained** (variant B): it ingests findings itself from locator `args`, symmetric to how `rust-audit` scouts its own diff base. |

## Artifacts

### Naming

- **Skill: `addressing-findings`** — bare (cross-cutting) name, pairs with
  `superpowers:receiving-code-review`. The triage discipline is genuinely
  language-agnostic; the Rust-specific wiring (which agents to dispatch, the "what proves
  what" table) is factored into a `rust.md` sub-file — mirroring how `debugging` is
  bare-but-Rust.
- **Workflow: `workflows/triage-findings.js`** — named for its honest job (triage + plan),
  not "fix" (it applies nothing). Workflow files are not `rust-`-prefixed (matches
  `rust-audit.js`).

### Unified finding schema

Reuses `rust-audit`'s field names (`workflows/rust-audit.js:42-45`) so a `rust-audit`
report maps onto this schema **mechanically**, plus the fields the fix side needs:

```
{
  stable_id,      // durable identity: hash(source + location + title) — see "Stable id & ledger"
  source,         // "rust-audit" | "rust-reviewer" | "rust-security-scanner" | "github-pr" | ...
  severity,       // Critical | High | Medium | Low | Info   (same vocabulary as rust-audit)
  title,          // short "what"
  location,       // "file:line" | "crate/module" | "PR-level" | null   (location may be absent)
  detail,         // "why"
  proposed_fix,   // optional — the fix direction from the source, if any
  thread_id,      // optional — GitHub review thread id (for loop closure)
}
```

After the Validate phase each finding carries a **compact** triage result (kept small so
the barrier-plan agent does not blow up on a large PR — see M1):

```
{ stable_id, verdict, reason, fix_pointer }
// verdict ∈ accept | reject | defer | needs-decision | conflict
// fix_pointer = owning topic skill + one-line direction (NOT the full proof text)
```

### Stable id & triage ledger (the unifying mechanism)

A **stable id** = `hash(source + location + title)` gives every finding a durable identity.
A **triage ledger** (a persisted artifact, e.g. `triage-ledger.json` next to the plan)
records the verdict + reason for every finding keyed by `stable_id`. This single mechanism
resolves the cluster of gaps the review raised:

- **Idempotency on re-run** — a re-run reads the ledger; already-`reject`ed/`defer`red
  findings are not re-litigated or flip-flopped.
- **Re-review identity** — the re-review loop (step 7) can tell "same finding as last round"
  from "new finding" by `stable_id`, so "loop until green" measures progress, not churn.
- **Deferred tracking** — deferred findings stay visible across runs instead of vanishing.

### Triage outcomes

Validation against the code (pinned to a ref — see M2) yields one of:

- `accept` — valid, in scope → enters the plan.
- `reject` — wrong / not a real problem → recorded with reasoning, pushback drafted
  (delegates judgment to `superpowers:receiving-code-review`).
- `defer` — valid but out of scope for now → recorded in the ledger, stays deferred.
- `needs-decision` — valid but needs a product/spec decision → routed to `specs`.
- `conflict` — contradicts another finding ("make it generic" vs "make it concrete") →
  both surfaced for a human decision; never silently pick one. Detected in the barrier
  (Plan) phase, where all findings are visible together.

**Locationless findings** (file-level or PR-level comments with no `file:line`) get an
explicit lane: triage tries to resolve a concrete location; if it cannot, the finding is
routed to `needs-decision` rather than dropped (`rust-review:108` — "a finding without a
location isn't actionable").

## The skill — `addressing-findings`

SKILL.md stays lean (the 8-step flow + the scaling rule + boundaries). Detail lives in
sub-files (progressive disclosure):

- `rust.md` — Rust wiring: which agents to re-dispatch, the cited "what proves what" table.
- `github.md` — `gh` incantations to read PR threads, and the reply/resolve API calls.
- `schema.md` — the unified finding schema + per-source mapping + stable id.

### Process flow

`⫲` marks a step that **fans out across subagents** — see "Parallelism via subagents" below.

```
1. Gather  ⫲ — collect findings from both sources, one subagent per source in parallel:
               • craft: a rust-reviewer verdict / a rust-audit report
               • GitHub: gh pr view / gh api → inline thread comments
2. Normalize — to the unified schema; tag source; compute stable_id
3. Triage  ⫲ — per finding, validated against a pinned ref, fanned out one subagent per
               finding: accept / reject / defer / needs-decision / conflict (+ reasoning)
               (generic feedback discipline → superpowers:receiving-code-review)
4. Order     — accepted only: blocking → simple → complex; group by file to cut churn
               (the grouping is what makes step 5 parallelisable — independent groups)
5. Fix     ⫲ — independent file-groups fixed concurrently, one subagent per group
               (superpowers:subagent-driven-development; worktree isolation when groups
               could touch shared files). Within a group, serial. "How to fix" delegated
               to topic skills (rust-errors / rust-ownership / …); a bug → write the
               regression test first, RED→GREEN (cite superpowers:test-driven-development
               + rust-testing — do not restate)
6. Verify    — per fix: cite the rust-review "what proves what" table
               (+ superpowers:verification-before-completion)
7. Re-review ⫲ — re-dispatch the review agents in parallel (rust-reviewer / security /
               miri — as rust-audit already does); new findings re-enter the loop;
               the ledger (stable_id) dedups; repeat until green
8. Close loop— (GitHub) draft thread replies (what was fixed / why rejected + the commit),
               post & resolve ONLY after explicit user OK; map reply→thread via thread_id
```

### Parallelism via subagents

The discipline of fanning out independent work is owned by
`superpowers:dispatching-parallel-agents` (ad-hoc fan-out) and
`superpowers:subagent-driven-development` (executing independent plan tasks via subagents);
this skill points at them rather than restating the method. Where each applies:

- **Gather (step 1)** — the two sources are independent → one subagent per source,
  concurrently. (In the workflow this is the `Gather` phase via `parallel()`.)
- **Triage (step 3)** — each finding is judged independently → one subagent per finding.
  This is the core fan-out (in the workflow, the `Validate` phase). The barrier afterwards
  (dedup / conflict / order) genuinely needs all results together, so it does **not**
  parallelise.
- **Fix (step 5)** — the plan is grouped by file precisely so **independent groups run
  concurrently**, one subagent per group, via `superpowers:subagent-driven-development`.
  Use worktree isolation only when groups could touch shared files; within a single group,
  edits stay serial. This refines decision 3's "serial": the *workflow* applies nothing and
  the *plan* is applied through executing-plans, but application across non-overlapping
  groups is parallel.
- **Re-review (step 7)** — the review agents run in parallel, exactly as `rust-audit`
  already orchestrates them.

**Scaling rule:** small batch → steps 2–4 inline. Large batch (a fat `rust-audit` report,
a 40-comment PR) → dispatch the `triage-findings` workflow, then apply its plan via
`superpowers:executing-plans`, then run the re-review loop.

## The workflow — `triage-findings.js`

Self-contained (variant B), symmetric to `rust-audit`: it scouts/gathers its own input.

- **Input (locators, not payload):** `args = { pr?, base?, report? }`
  - `pr` — a GitHub PR number → gather inline thread comments via `gh`.
  - `report` — path to an existing `rust-audit` report (or a saved reviewer verdict) to ingest.
  - `base` — the diff base / ref to **pin validation against** and use as diff context. It
    is *not* a trigger to run the heavy review agents — that is `rust-audit`'s job. To feed
    craft-agent findings, run `rust-audit` (or a reviewer) first and pass its `report`. This
    keeps the two workflows composable without nesting and avoids duplicating `rust-audit`.
- **Phases** (three harness `phase()` calls; normalization is folded into Gather
  post-processing rather than its own phase):
  - `Gather` — **`parallel()` over sources** (one agent per requested source: `pr`,
    `report`), schema-enforced; then normalize in-script — tag `source` and compute
    `stable_id`.
  - `Validate` — **parallel per-finding agent** (the core fan-out), **pinned to the ref**,
    emitting the *compact* triage result `{ stable_id, verdict, reason, fix_pointer }`
    (M1: keep small).
  - `Plan` — **barrier** (needs all findings at once, justified by dedup/conflict): read
    the existing ledger for idempotency → dedup by `stable_id` → detect `conflict` → group
    accepted by file → order blocking→simple→complex → render the plan **in the
    `superpowers:writing-plans` format** (so `executing-plans` ingests it directly) and
    update the triage ledger.
- **Output:**
  - a fix plan in writing-plans format (accepted findings only), and
  - the updated `triage-ledger.json` (accept/reject/defer/needs-decision/conflict, keyed by
    `stable_id`), plus a human-readable summary of reject/defer/needs-decision/conflict
    with reasons.
- **Applies nothing.** Edits follow via `superpowers:executing-plans`.

### Why the workflow earns its place (vs skill + `dispatching-parallel-agents`)

It is more than homogeneous parallel dispatch: it is a **deterministic, schema-enforced,
multi-source ingestion + triage pipeline** with a **durable ledger** and a **one-command
entry** (`run triage-findings on PR #123`). That bundle — determinism, schema enforcement
at every stage, idempotent re-runs, writing-plans-format output — is what `dispatching-
parallel-agents` (a guidance skill, not a script) does not provide. This is the same bar
`rust-audit` clears.

## Boundaries (delegation)

- *How* to fix a specific problem → topic skills (`rust-errors`, `rust-ownership`,
  `rust-concurrency`, …).
- *How* to write the missing test → `rust-testing`; the RED→GREEN mechanic →
  `superpowers:test-driven-development` (cite, don't restate).
- Generic feedback discipline → `superpowers:receiving-code-review`; proof →
  `superpowers:verification-before-completion`; plan formalization/execution →
  `superpowers:writing-plans` / `executing-plans`.
- Fanning work out across subagents (Gather / Triage / Fix / Re-review) →
  `superpowers:dispatching-parallel-agents` (ad-hoc fan-out) and
  `superpowers:subagent-driven-development` (independent plan tasks). Cite, don't restate.
- Findings that need product/spec input → `specs`.
- The skill does **not** rewrite for the reviewer and does **not** duplicate the
  `rust-review` rubric or its "what proves what" table (it cites them).

## Changes to existing files

- **`skills/rust-review/SKILL.md`** — slim the "Requesting a review & acting on the verdict"
  section (the `Block → fix / Warning → judge / Approve / Wrong finding → push back` list
  and the `blocking → simple → complex` ordering) down to a **pointer**:
  *"acting on a verdict systematically → `addressing-findings`."* Keep the "Proving a claim
  — what proves what" table and the rubric here. Resolves the two-owners overlap (H2).
- **`MAP.md`** — add the `addressing-findings` skill row (Cross-cutting table) and a
  `triage-findings` row to the Workflows table; note the rust-review re-pointing.
- **`README.md`** — add the skill and workflow to the Contents table.
- Cross-links: `rust-review` gains a forward pointer to `addressing-findings`;
  `addressing-findings` cites `debugging` / `rust-testing` from steps 5–6.

## Open / minor

- Workflow file name `triage-findings.js` chosen over `fix-plan.js` for honesty (it
  triages + plans, applies nothing) and over `addressing-findings.js` to avoid implying it
  does the addressing. Revisit if a better stem emerges.
