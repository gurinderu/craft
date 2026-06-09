---
name: rust-architecture-review
description: Rust architecture-audit rubric — builds a whole-project dependency graph (crates and modules), then judges structure against a severity-tiered checklist (dependency cycles, inverted dependencies, layer leaks, god modules, anemic domain) AND over-engineering (ghost abstractions, over-layering, generic soup), and issues a Healthy/Concerns/At-risk health rating. Bidirectional — flags both too little and too much structure. Use when auditing the architecture of a Rust project or workspace, checking layering, or assessing structural debt. Triggers: structural debt, dependency cycle, layer leak, god module, is this over-engineered, hexagonal audit.
---

# Rust Architecture Review

The rubric for auditing a Rust project's **whole-graph structure** — not a diff. Build the dependency graph, judge it against the severity tiers, then issue a health rating. This is the knowledge; the `rust-architecture-reviewer` agent applies it to an actual codebase and reports back. The design vocabulary it leans on (ports, adapters, domain core, the criticism of cargo-culting) lives in the `rust-architecture` skill.

## When to Use

- Auditing the architecture of an existing Rust project or workspace
- Assessing structural debt before a large refactor
- Sanity-checking whether a structure is appropriate for the project's size — in **both** directions (under- and over-engineered)

This judges structure, not changes. For diff/PR review use `rust-review`.

## Judging philosophy — appropriateness, both directions

Structure should match the project's real complexity. The upper tiers catch broken structure (leaks, cycles); the lower tiers catch needless structure (abstractions with one implementor, layering a 300-line crate doesn't need). Take the `rust-architecture` criticism section seriously: "hell is full of single-implementation abstractions." Do not reward indirection for its own sake.

## Step 1 — Build the graph (hybrid)

Determine the perimeter from the root `Cargo.toml`: a `[workspace]` with multiple members → analyze the **crate graph**; a single package → analyze the **module graph**.

```bash
# crate graph
cargo metadata --no-deps --format-version 1   # members + intra-workspace deps (preferred)
cargo tree --workspace                         # fallback view of dependency edges
# module graph
cargo modules structure --package <pkg>        # if cargo-modules is installed
```

If a tool is absent, say so (`cargo-modules not installed — using source analysis`) and fall back to `Grep` over `use`, `mod`, and `pub use` declarations plus the `[dependencies]` tables in each `Cargo.toml`. Never block on a missing tool — the gate is "did we get a graph", not "is the tool present".

## Step 2 — Severity checklist

Report findings as `severity · location · what · why · fix`. A finding without a location isn't actionable.

### CRITICAL — integrity broken

- **Dependency cycle** between modules or crates (objective, straight from the graph).
- **Inverted dependency direction** — a domain/core module imports infrastructure: `sqlx`, `axum`, `reqwest`, `tokio::net`, `hyper`, a concrete DB/HTTP client. The domain must not know the outside world (dependency rule → `rust-architecture`).

### HIGH — significant structural debt

- **Business logic in an adapter** — non-trivial computation or decision logic inside an HTTP handler, CLI command, or repository impl instead of the domain.
- **God module** — fan-in > 8 dependents **and** a size hub (~> 500 LOC); the thing everything reaches into.
- **Anemic domain** — domain types are plain data holders while a single `Service`/`Manager`/`Helper` does all the work (behavior belongs with the data it operates on).

### MEDIUM — smells & appropriateness (over-engineering side)

- **Ghost abstraction** — a trait/port with exactly one implementor and no test double; pure indirection. Use the concrete type until a second implementor or a real testing seam appears.
- **Over-layering for size** — full ports & adapters scaffolding in a tiny crate with a single external dependency; the indirection costs more than it saves.
- **Generic soup** — `Service<R, M, N>` style structs with `Clone + Send + Sync + 'static` bounds propagating across the codebase, fighting the language.

### LOW / INFO

- Mixed organization (by-layer and by-feature intermixed); unclear seams or entry points.

Thresholds (fan-in > 8, > 500 LOC) are tunable defaults — apply judgment around them, don't treat them as hard gates.

## Step 3 — Health rating

| Rating | When |
|---|---|
| **At-risk** ⛔ | any CRITICAL, or ≥ 3 HIGH |
| **Concerns** ⚠️ | ≥ 1 HIGH, or several MEDIUM |
| **Healthy** ✅ | only LOW / INFO |

## Boundaries

- *How* to introduce a port, lay out a domain, or decide whether to abstract → `rust-architecture` (this rubric only judges the existing graph).
- Diff-scoped / mergeability review → `rust-review`.
- This skill judges; it does not rewrite. Propose the fix, let the author apply it.
