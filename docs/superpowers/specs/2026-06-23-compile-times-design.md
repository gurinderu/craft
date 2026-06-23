# Cutting Rust compile times — design

**Date:** 2026-06-23
**Status:** Approved, ready for implementation plan
**Scope:** one new sub-file in `rust-performance` plus a SKILL entry. Skill-content only — not
review-relevant, no agent/workflow change. Orthogonal to the other three specs.

## Problem

`rust-performance` owns "build config" but only along one axis: tuning the build to make the
**binary faster at runtime** (`lto`, `codegen-units = 1`, `target-cpu`, PGO — in `optimizing.md`).
The **inverse axis** — tuning the build to make the **edit→compile→run loop faster** — is not
covered anywhere in craft. That is a distinct and very common developer pain, and the two axes pull
in *opposite directions* on several knobs (`codegen-units`, `lto`, `opt-level`), so leaving one
axis implicit invites contradictory advice.

## Source

Prompted by Feldera's ["30→2 minutes with one thousand crates"](https://www.feldera.com/blog/cutting-down-rust-compile-times-from-30-to-2-minutes-with-one-thousand-crates).
The headline (1,106 auto-generated crates, content-hash crate names) is **niche** — it only works
because their code is deterministically generated from a dataflow graph. But the underlying lever
**generalizes**: rustc parallelizes at *crate* granularity and caches incrementally per crate, so
crate structure is itself a compile-time lever. craft should capture the generalizable toolkit, not
the niche headline.

## Design

A new `skills/rust-performance/compile-times.md` covering the fast-iteration toolkit, ordered by
effort/payoff. `rust-performance/SKILL.md` gets an entry pointing to it and an explicit **two-axes**
note distinguishing it from `optimizing.md`.

### Techniques

1. **Faster linker** — the cheapest large win on incremental/link-heavy builds: `mold` (Linux),
   `lld` (cross-platform), the modern default linker on recent macOS. Configure via
   `.cargo/config.toml` rustflags. Caveat: platform-specific; note current macOS defaults.
2. **Crate splitting for parallelism + incremental** — a monolith crate serializes compilation and
   forces a full rebuild on any change; splitting into workspace crates lets cores work in parallel
   and rebuilds only the changed crate. Caveat: over-splitting adds linking/boilerplate overhead —
   balance, don't chase 1,000 crates. Cross-link `rust-ecosystem` (workspaces, dependency weight).
3. **Monomorphization as a compile-time cost** — heavy generics inflate codegen + LLVM time. Reduce
   by fewer instantiations, `dyn` at boundaries, and the "thin generic outer fn → non-generic inner
   fn" trick. Honest tradeoff: trades a little runtime for compile speed. Cross-link `rust-traits`
   (dispatch) — the dispatch choice has a compile-time dimension, not just runtime.
4. **Dev profile tuning** — `opt-level = 0` (or `1` when the dev loop itself is CPU-bound),
   `debug = "line-tables-only"`, `split-debuginfo = "unpacked"` (macOS), keep `incremental = true`
   (the dev default), and `[profile.dev.package."*"] opt-level = N` to optimize *dependencies* while
   keeping your own crate cheap to rebuild. Use `cargo check` for type-only loops.
5. **Caching** — `sccache` for shared/CI caches; understand the incremental cache; avoid needless
   `cargo clean`.
6. **`codegen-units` calibration** — a correction to common advice: for *compile speed* the dev
   default (256) already parallelizes, and raising it further rarely helps (matching Feldera's null
   result); the levers that matter are linker + crate split, not more codegen-units. Lowering it to
   `1` is a *runtime* optimization (`optimizing.md`) that **costs** compile time — the opposite
   axis. State both explicitly.
7. **Trim deps and features** — fewer/leaner dependencies and pruned features shrink the compile
   graph (`default-features = false`, audit with `cargo tree`). Cross-link `rust-ecosystem`.

### Diagnostics

Lead with measurement (consistent with the skill's measure-first ethos): `cargo build --timings`
(HTML report — find the critical path and slow crates), `cargo llvm-lines` (monomorphization
bloat), `-Z self-profile` (nightly) for deeper rustc profiling.

### SKILL wiring

- `rust-performance/SKILL.md` — new entry linking `compile-times.md`; a one-paragraph "two axes"
  framing (runtime-fast build vs iteration-fast build, and which knobs flip between them).
- Update the skill `description`/triggers to surface the topic: `compile times`, `mold`, `lld`,
  `sccache`, `cargo --timings`, `cargo llvm-lines`, `incremental`.

## Non-goals

- Not review-relevant — no review rubric, agent, or workflow change.
- Not runtime optimization — that stays in `optimizing.md`; this file is its counterpart and
  cross-references it where the same knob has opposite effects.
- Do not recommend auto-generating hundreds of crates — that is the source's niche, not general
  advice; capture the lever (crate granularity), not the extreme.

## Risk

Negligible — one additive sub-file plus a SKILL entry and description update; no behavior change to
any agent or workflow.
