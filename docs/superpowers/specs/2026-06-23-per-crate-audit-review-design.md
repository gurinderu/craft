# Audit review enhancements: per-crate review + inter-crate contracts + crate decomposition — design

**Date:** 2026-06-23
**Status:** Approved (verbally), ready for implementation plan
**Scope:** two workflow edits plus one new skill sub-file. Builds on the elastic-deep-review engine.
Three complementary audit features: (A) per-crate parallel review (inside each crate), (B)
inter-crate contract review (the seams *between* crates), and (C) crate-decomposition advice (when
and how to extract code into its own crate, or merge an over-split one).

## Conceptual model (keep these distinct)

- **`rust-review` workflow** — reviews *a change* (diff-scoped, elastic deep engine). The single
  review path. It does **not** change behaviour here; it only gains one optional, backward-
  compatible argument.
- **`rust-audit`** — the *full audit* of the project, and what "a full review" means here: it
  already runs the **architecture**, **security**, and **Miri** dimensions alongside review, and
  features A + B below complete it (per-crate review + inter-crate contracts). There is no separate
  "full review" concept — running the audit *is* the full review. Per-crate parallelism is a
  property of **the audit**, not of the review workflow: the audit orchestrates N review runs (one
  per crate) instead of one run over the whole workspace.

  The dimensions compose into the comprehensive picture: **architecture** sees the whole dependency
  graph's shape, **per-crate review** sees inside each crate, **contracts** see the edges between
  crates, **crate-decomposition** judges whether the crate boundaries themselves are right,
  **security**/**Miri** cover deps and unsafe. Together they are the full review.

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

## Crate-decomposition advice (feature C)

Per-crate review and contracts take the crate boundaries as given. Feature C questions the
boundaries themselves: **when is code better pulled out into its own crate, and how** (and the
reverse — when an over-split crate should be merged back).

### 7. Knowledge — `skills/rust-ecosystem/crate-extraction.md` (new sub-file)

`rust-ecosystem` owns workspaces and crate granularity, so the decision framework lives there:

- **When (drivers — each a signal to extract):** the code is consumed by more than one
  crate/binary (**reuse**); it is a compile hotspot or serializes the build (**compile
  parallelism** → `rust-performance` [compile-times.md](../rust-performance/compile-times.md)); a
  port/trait + adapters belong behind a boundary so the core doesn't depend on the framework
  (**dependency inversion** → `rust-architecture` ports); a swappable/sandboxed plugin or FFI
  surface (**trust boundary** → `rust-plugins`); code that must **version/publish independently**;
  heavy integration-test dependencies that shouldn't leak into the main build (**test isolation**);
  a **god-crate** with internally separable concerns.
- **How (mechanics):** add a `[workspace] members` entry, move the module, expose a minimal `pub`
  API (visibility → `rust-idioms`), re-export from the original crate for compatibility if needed,
  set version/edition, and manage the semver of the new public surface.
- **When NOT to (anti-driver):** every crate boundary costs linking + boilerplate + coordination;
  don't extract a single-consumer module with no reuse/compile/boundary driver, and don't extract
  prematurely — it ossifies an API you're still moving. The reverse signal: a crate with one
  consumer and no boundary reason should be **merged back**.

### 8. `rust-audit` crate-decomposition dimension

A new **whole-project** dimension (not diff-scoped — boundaries are a property of the project, not
a diff). A generic `agent()` (no new agent type) loads the `rust-ecosystem` crate-extraction rubric
and the workspace dependency graph, and returns recommendations — each as a finding naming the
**driver** (why), the **boundary** (what code), and the **how** — for both extractions and merges.
It runs even on a single-crate project (the god-crate split question still applies). It joins the
same `parallel(tasks)` call as the other dimensions; dimension label `crate-decomposition`.

## Files to change

- `workflows/rust-review.js` — Scout honours optional `args.path` (scope the diff; name the crate).
  (Used by feature A only; the contracts and decomposition dimensions do not touch `rust-review`.)
- `skills/rust-ecosystem/crate-extraction.md` — **NEW** (feature C knowledge); linked from
  `skills/rust-ecosystem/SKILL.md`.
- `workflows/rust-audit.js` — Scout returns `crates`/`changedCrates`/`edges`; **review** dimension
  fans out per crate (feature A) with the single-review fallback; **contracts** dimension fans out
  per touched edge (feature B) via direct `craft:rust-reviewer` agents; **crate-decomposition**
  dimension (feature C) is one whole-project generic agent loading the crate-extraction rubric;
  `expectedDimensions`/`notRun` built from the dispatched `review:<crate>` + `contract:<from>→<to>`
  + `crate-decomposition` + architecture/security/[miri] labels (intentional skips — contracts with
  no edges, Miri with no unsafe — are not counted as NOT RUN); synthesis prompt notes the per-crate
  review rows, the per-edge contract rows, and the crate-decomposition recommendations.

## Non-goals

- No change to `rust-review`'s default behaviour or to it being the single review path — only the
  additive optional `path` arg.
- No whole-crate (non-diff) review mode — per-crate runs stay diff-scoped (the "all crates" branch
  only triggers when there's no diff base, and each run still reviews what `rust-review` reviews).
- The contracts dimension does **not** duplicate `rust-architecture-reviewer`: architecture judges
  the *shape* of the dependency graph (cycles, layering, god modules); contracts judge whether a
  caller *honours the callee's contract* across an edge. Different question, different rubric.
- Crate-decomposition is **distinct from architecture and from compile-times**: architecture judges
  the existing graph's shape; compile-times treats crate-splitting as one parallelism lever;
  crate-decomposition is the focused *when/how to change the crate boundaries* decision, with all
  drivers (reuse, compile, dependency inversion, trust boundary, release cadence, test isolation,
  god-crate). It **recommends**, it does not move code — no auto-refactoring.
- Cost: per-crate review is N × the deep engine for N changed crates; contracts is one focused
  agent per touched edge. This is the full audit (release/big-merge), and the harness concurrency
  cap bounds simultaneity across the whole fan-out. Accepted by design.

## Risk

Low and additive. Per-crate review falls back to today's single whole-workspace review on a
single-crate workspace, a `cargo metadata` failure, or no detected crates; `rust-review` with no
`path` is byte-for-byte today's behaviour. The contracts dimension is skipped cleanly when there
are no intra-workspace edges, so single-crate and non-workspace projects see no contracts noise.
