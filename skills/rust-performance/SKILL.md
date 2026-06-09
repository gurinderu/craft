---
name: rust-performance
description: Rust performance — measure-first methodology, benchmarking (criterion/divan), profiling, and concrete optimizations (build config, heap allocations, hashing, type sizes, iterators). Use when code is slow, when optimizing a hot path, choosing a benchmark/profiler, or tuning build settings. Triggers: performance, optimization, slow, faster, benchmark, criterion, divan, profiling, flamegraph, perf, allocation, arena, bumpalo, compact string, hashing, FxHashMap, LTO, codegen-units, target-cpu, PGO, SIMD, autovectorize, inline, cold path, cache, hot path, jemalloc, mimalloc, global allocator, dhat, heap profiling, buffered I/O, BufWriter, BufReader, lock stdout, swap_remove, make it faster.
---

# Rust Performance

Performance work is a loop: **measure → profile → fix the hot spot → re-measure**. Most of the
craft is *not* writing clever code — it's refusing to optimize anything you haven't measured.
Concrete techniques distilled from the [Rust Performance Book](https://nnethercote.github.io/perf-book/)
are in the sub-files.

## When to Use

- Code is too slow and you need to find out why
- Optimizing a known hot path
- Choosing a benchmarking tool or profiler
- Tuning build/compile settings for speed or size

## The discipline: measure, don't guess

Intuition about Rust performance is wrong more often than not — the optimizer, cache effects,
and allocation patterns dominate in non-obvious ways. The rule:

1. **Build in release.** `--release` (or `cargo bench`). A debug build is 10–100× slower and
   tells you nothing about real performance — never benchmark or profile a dev build.
2. **Establish a baseline.** Benchmark the current code so you can prove a change helped
   ([benchmarking.md](benchmarking.md)).
3. **Profile to find the hot spot.** Don't optimize where you *think* time goes — measure it
   (`cargo flamegraph`, `samply`, `perf`; allocation volume won't show in a CPU profile — use a
   heap profiler, `dhat`). Optimize the top of the profile, nothing else.
4. **Apply a targeted fix** ([optimizing.md](optimizing.md)) — one change at a time.
5. **Re-measure.** Keep the change only if the benchmark moved; revert if not. "Tiny changes in
   memory layout can cause significant but ephemeral fluctuations" — confirm, don't assume.

Algorithmic complexity beats micro-optimization: an O(n²)→O(n log n) change outweighs any amount
of allocation tuning. Fix the algorithm first, then the constants.

## Free wins — build configuration

Before touching code, these settings often buy 10–20% with zero source changes (full toml and
tradeoffs in [optimizing.md](optimizing.md)):

```toml
[profile.release]
lto = "fat"            # cross-crate inlining: 10-20%+, slower compile
codegen-units = 1      # more optimization, slower compile
panic = "abort"        # smaller/faster, no unwinding
```
```toml
# .cargo/config.toml — newer CPU instructions (binary won't run on older CPUs)
[build]
rustflags = ["-C", "target-cpu=native"]
```

## Where time and memory usually go

When the profiler points at code, the usual culprits — each with concrete fixes in
[optimizing.md](optimizing.md):

| Symptom | Look at |
|---|---|
| lots of `malloc`/`free`, `Vec` growth | heap allocations — `with_capacity`, reuse, `smallvec`, `Box<[T]>`, arenas (`bumpalo`), compact strings; swap the global allocator (jemalloc/mimalloc); find them with `dhat` |
| hashing hot, many `HashMap` lookups | swap SipHash for `FxHashMap`/`ahash` |
| big `memcpy`, large stack frames | type sizes — box large enum variants, smaller ints |
| tight loops with indexing | iterators (often elide bounds checks); autovectorize the hot loop; avoid redundant work |
| release binary already LTO'd, still need more | profile-guided optimization (PGO); `#[cold]` on slow paths |
| slow stdout / many small reads or writes | I/O — buffer (`BufReader`/`BufWriter`), lock stdout once, `read_until` |

## Boundaries

- *Correctness* tests for the code you're optimizing → `rust-testing`. Performance changes are
  exactly when a regression test pays off.
- Safe SIMD (autovectorization, `std::simd`, `wide`/`pulp`) is covered here. `get_unchecked`,
  architecture-specific intrinsics (`std::arch`, `target_feature`) and other `unsafe` speedups →
  `rust-unsafe`; reach for them only after the safe options and with a benchmark proving the win.
