# Audit review enhancements: per-crate review + inter-crate contracts — design

**Date:** 2026-06-23
**Status:** Approved (verbally), ready for implementation plan
**Scope:** two workflow edits. Builds on the elastic-deep-review engine. Two complementary audit
features: (A) per-crate parallel review (inside each crate), and (B) inter-crate contract review
(the seams *between* crates that per-crate review is blind to).

## Conceptual model (keep these distinct)

- **`rust-review` workflow** — reviews *a change* (diff-scoped, elastic deep engine). The single
  review path. It does **not** change behaviour here; it only gains one optional, backward-
  compatible argument.
- **`rust-audit`** — the *full audit* of the project (review + architecture + security + miri).
  Per-crate parallelism is a property of **the audit**, not of the review workflow: the audit
  orchestrates N review runs (one per crate) instead of one run over the whole workspace.

## Problem

`rust-audit`'s review dimension currently calls `workflow('rust-review', { base })` **once** for
the whole workspace. On a multi-crate workspace this neither isolates crates nor parallelizes the
review across them — one big review instead of per-crate concurrency.

## Decision

The audit fans the review dimension **out per crate, in parallel**:

- **Depth:** the **full** `rust-review` engine per crate (scout → lenses → loop → verify →
  synthesize), nested one level (audit → review). Each `rust-review` never calls `workflow()`
  itself, so the one-level nesting rule holds.
- **Crate selection:** crates with `.rs` changes vs the diff base (diff-scoped, matching how
  `rust-review` already works — an unchanged crate would yield nothing). If there is **no base /
  clean tree**, the audit covers **all** workspace crates.
- **Fallbacks:** a single-crate workspace, a `cargo metadata` failure, or no crates detected →
  one whole-workspace `rust-review` call (today's behaviour). Never fail the audit on detection.

## Design

### 1. `rust-review` — optional `path` argument (backward-compatible)

`rust-review` accepts an optional `args.path` (a crate directory). Its Scout scopes the diff to
that path (`git diff <base>... -- <path>`) and names the crate in the scout/lens briefs. Absent
`path` → whole tree, exactly as today. This is additive: existing callers and the standalone
review path are unchanged.

### 2. `rust-audit` Scout — detect workspace crates

The audit's scout (already resolves `baseRef`, `hasDiff`, `hasUnsafe`) additionally returns the
workspace's crates and which of them changed:

- `crates`: `[{ name, path }]` from `cargo metadata --no-deps --format-version 1` (workspace
  members only). Empty array if `cargo metadata` is unavailable.
- `changedCrates`: the subset whose `path` contains a `.rs` file in
  `git diff --name-only <base>...HEAD` (or `git status --porcelain` for uncommitted work).

### 3. `rust-audit` review dimension — per-crate fan-out

Replace the single review thunk with a selection + fan-out:

```
reviewCrates =
  changedCrates.length ? changedCrates           // diff-scoped: only changed crates
  : (baseRef ? [] : crates)                        // no base → all crates; base but no changes → none
reviewThunks =
  reviewCrates.length > 1
    ? reviewCrates.map(c => () => workflow('rust-review', { base, path: c.path })
        .then(report => reviewResult(`review:${c.name}`, report)))
    : [ () => workflow('rust-review', baseRef ? { base } : {})
        .then(report => reviewResult('review', report)) ]   // 0/1 crate → today's single review
```

`reviewResult(dimension, report)` is the existing mapping (regex-derived verdict + the report
sliced into a single `Info` finding), with the dimension label carrying the crate name. Each
thunk `.catch(() => null)`. These thunks join the existing architecture/security/miri thunks in
the one `parallel(tasks)` call, so all dimensions still run concurrently and the harness
concurrency cap applies across the whole fan-out.

### 4. Synthesis — per-crate review dimensions

The synthesis prompt already merges arbitrary dimension results; it needs only to expect multiple
`review:<crate>` dimensions and treat each as its own row. The `expectedDimensions` / `notRun`
bookkeeping is built from the dimensions actually dispatched (the per-crate review labels +
architecture/security/[miri]), so a per-crate review that returns null is flagged NOT RUN like any
other.

## Inter-crate contract review (feature B)

Per-crate review reviews *inside* each crate; it is blind to the **seams between crates** — whether
crate A actually uses crate B's public API the way B's contract intends. The audit adds a
**contracts** dimension for those seams.

### 5. `rust-audit` Scout — intra-workspace dependency edges

In addition to `crates`/`changedCrates`, the scout returns the **intra-workspace dependency edges**
from `cargo metadata --format-version 1`: `edges: [{ from, to }]` where both `from` (caller) and
`to` (callee) are workspace members and `from` depends on `to`. Empty if `cargo metadata` is
unavailable.

### 6. `rust-audit` contracts dimension — per-edge fan-out

For each **touched** edge — one whose caller `from` is a changed crate (its usage may have moved)
or whose callee `to` is a changed crate (its public API may have moved) — dispatch one focused
`craft:rust-reviewer` agent **in parallel**, reviewing whether `from` uses `to`'s **public API**
per its contract:

- signatures / types at the boundary, error & panic contracts, documented invariants and trait
  laws, and semver/breaking-change compatibility of `to`'s public surface vs `from`'s usage.
- The agent loads the contract rubric: `rust-review` (api-design pass), `rust-errors` (error
  contracts), `rust-traits` (trait laws). Dimension label `contract:<from>→<to>`.

This dimension uses a **direct agent per edge** (not the nested `rust-review` workflow) — a focused
cross-boundary review, lighter than the deep engine, which is the right tool for a seam check. The
edge thunks join the same `parallel(tasks)` call as the per-crate reviews and the other dimensions.

**Selection / fallbacks:** no base / clean tree → all intra-workspace edges; no intra-workspace
edges (single crate or independent crates) → skip the contracts dimension with a `log()` note (not
NOT-RUN — it is an intentional skip, like Miri without unsafe); `cargo metadata` failure → skip
edges, log it. Never fail the audit on detection.

## Files to change

- `workflows/rust-review.js` — Scout honours optional `args.path` (scope the diff; name the crate).
  (Used by feature A only; the contracts dimension does not touch `rust-review`.)
- `workflows/rust-audit.js` — Scout returns `crates`/`changedCrates`/`edges`; **review** dimension
  fans out per crate (feature A) with the single-review fallback; **contracts** dimension fans out
  per touched edge (feature B) via direct `craft:rust-reviewer` agents; `expectedDimensions`/`notRun`
  built from the dispatched `review:<crate>` + `contract:<from>→<to>` + architecture/security/[miri]
  labels (the skipped contracts case is not counted as NOT RUN); synthesis prompt notes the
  per-crate review rows and the per-edge contract rows.

## Non-goals

- No change to `rust-review`'s default behaviour or to it being the single review path — only the
  additive optional `path` arg.
- No whole-crate (non-diff) review mode — per-crate runs stay diff-scoped (the "all crates" branch
  only triggers when there's no diff base, and each run still reviews what `rust-review` reviews).
- The contracts dimension does **not** duplicate `rust-architecture-reviewer`: architecture judges
  the *shape* of the dependency graph (cycles, layering, god modules); contracts judge whether a
  caller *honours the callee's contract* across an edge. Different question, different rubric.
- Cost: per-crate review is N × the deep engine for N changed crates; contracts is one focused
  agent per touched edge. This is the full audit (release/big-merge), and the harness concurrency
  cap bounds simultaneity across the whole fan-out. Accepted by design.

## Risk

Low and additive. Per-crate review falls back to today's single whole-workspace review on a
single-crate workspace, a `cargo metadata` failure, or no detected crates; `rust-review` with no
`path` is byte-for-byte today's behaviour. The contracts dimension is skipped cleanly when there
are no intra-workspace edges, so single-crate and non-workspace projects see no contracts noise.
