# CI-aware mechanical gate — design

**Date:** 2026-06-23
**Status:** Approved, ready for implementation plan

## Problem

Every craft review agent runs a **mechanical gate** (`cargo fmt --check`, `cargo clippy
--all-targets -- -D warnings`, `cargo test`, plus `cargo audit` / `cargo deny`) before doing any
semantic review. The gate is currently a hard precondition, baked into three places:

- `agents/rust-reviewer.md` — Step 1 runs the whole gate locally, `Block` on first failure.
- `skills/rust-review/SKILL.md` — "Step 1 — Mechanical gate"; the verdict criteria are phrased in
  terms of "gate green / gate red".
- `workflows/rust-audit.js` and the sibling agents (`rust-security-scanner`, `rust-miri`) — each
  runs its own tools first.

When the change under review is a **PR that already ran these checks in CI**, re-running them in
the agent is:

- **Slow** — a cold build downloads crates and recompiles the world.
- **Sometimes impossible** — the agent environment may lack the toolchain, dependencies, or
  network; cloud reviews especially.
- **Redundant** — CI already computed the answer.

The gate cannot simply be deleted: it is the precondition that makes review worth doing, and the
verdict is coupled to it. The real question is **where the gate signal comes from**.

## Decisions (from brainstorming)

1. **Smart fallback.** If a PR with a conclusive CI signal exists, consume it. Otherwise (local
   uncommitted work, no CI, checks pending) run the gate locally exactly as today.
2. **Agent self-detects.** The agent itself queries GitHub via `gh`; it does not rely on the
   dispatcher's brief to tell it whether CI is authoritative. craft agents are self-contained per
   brief, so detection must live inside the agent.
3. **Hybrid granularity.** Trust green required CI checks for `build`/`test`/`clippy`/`fmt`.
   Security tools (`audit`/`deny`) are cheap and usually absent from CI, so they always run
   locally regardless of CI status.
4. **Scope: all agents.** Apply the CI-aware principle across all review agents, accepting that
   the win is near-zero for tools CI rarely runs (`geiger`, `semgrep`, Miri) — those keep running
   locally.

## Design

### 1. Canonical home

The principle is one sentence: **before running a check locally, ask whether CI already computed
it on this PR; if a conclusive required check covers it and is green, consume that result instead
of recomputing.**

This is a natural extension of the "what proves what" table in `rust-review` (which already has a
"trusted instead" column). The canonical protocol lives in **`skills/rust-review/SKILL.md`**,
reframing "Step 1 — Mechanical gate" into **"Step 1 — Establish the gate (CI-aware)."** Other
agents reference it rather than duplicating the text (collection principle: one owner, others
point).

### 2. Gate algorithm in the agent

```
1. Detect PR + CI:
     gh pr checks --json name,state,bucket,link   (for the current branch)
   gh missing / unauthenticated / no network / no PR found
     → fall straight through to the local gate (never fail on detection).

2. If a PR exists and its required checks are conclusive:
   • build/test/clippy/fmt checks that are green in CI → treat as PASSED,
     record provenance "via CI #N"
   • any of them failed → verdict Block; cite the failed check name + link; stop
   • pending / absent → fall through to running that command locally

3. Security part (audit/deny) — hybrid: always run locally if installed
   (cheap, usually absent from CI), independent of step 2.
```

Check-to-command mapping uses **name heuristics** (`fmt`, `clippy`, `test`, `build`/`check`). If a
check name is not recognized, it does **not** count as covered and the command runs locally — the
safe default is an extra run, never a skipped check.

Edge cases, all degrading to the local gate:
- `gh` not installed / not authenticated / offline.
- PR exists but no CI configured, or checks still pending.
- Local uncommitted work (`git diff HEAD` path) — no PR → local.

### 3. Verdict and output

Verdict criteria in the rubric: "gate green" now means **CI green OR local green**; "gate red"
means CI red OR local red. The output shows the provenance of the signal:

```
## Gate
clippy ✓ · test ✓ · fmt ✓   (via CI · PR #123)
audit ✓ · deny ✓            (local)
```

### 4. Per-agent coverage map

| Agent | Trust CI (if green) | Always local |
|---|---|---|
| `rust-reviewer` | fmt, clippy, test, build | audit, deny |
| `rust-security-scanner` | audit, deny (if a green check matches by name) | geiger, semgrep |
| `rust-miri` | a `miri` job, if present and green | Miri, when no such check |
| `rust-architecture-reviewer` | — (no build gate; reads structure) | — unchanged |

For `geiger` / `semgrep` / Miri the win is effectively nil — CI rarely runs them, so these agents
keep running locally; CI-aware just rarely fires there. This is expected, not a gap.

### 5. Files to change

- `skills/rust-review/SKILL.md` — Step 1 → CI-aware; adjust verdict criteria to accept a CI gate
  signal and cite provenance.
- `agents/rust-reviewer.md` — Step 1 workflow + output format (provenance line).
- `agents/rust-security-scanner.md`, `agents/rust-miri.md` — a short "check CI first" step that
  points at the rust-review CI-aware gate.
- `workflows/rust-audit.js` — the synthesis step should carry gate provenance through.
- Brief / CLAUDE.md — **no change** (the agent self-detects); the diff range is already passed.

## Non-goals

- No change to the dispatcher brief or CLAUDE.md review-routing.
- No attempt to map CI check names beyond simple substring heuristics; no per-repo config of check
  names in this iteration (the `git diff --merge-base main` range stays the contract).
- No new dependency: detection uses `gh`, which the agents may already invoke; absence degrades to
  the current behavior.

## Risk

Low by construction: every detection failure or ambiguity falls back to the current local-gate
behavior, so the worst case is "no improvement," never "a check silently skipped."

## Open input

If the user's Rust repos have a stable CI job-naming convention (e.g. in `.github/workflows`), the
step-2 heuristic should be tuned to it. Absent a known convention, the heuristic uses the safe
default: unrecognized name → run locally.
