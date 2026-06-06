# Debugging techniques

Concrete tools for the middle of the loop — reproduce, localize, explain.

## Shrink the reproduction

A smaller repro is a clearer cause. Remove everything not needed to trigger the bug:

- Delete unrelated code/inputs until the failure disappears, then put the last piece back.
- Replace dependencies with stubs; does it still fail? → the bug is in your code, not theirs.
- For data-driven failures, **minimize the input** (delta-debugging): halve it repeatedly,
  keeping whichever half still fails. `proptest`/`quickcheck` do this automatically — a failing
  property test hands you a minimal counterexample (→ `rust-testing`).

The goal: one deterministic failing test you can run in seconds.

## Bisection — find *where* / *when*

Binary-search the problem space instead of reading everything.

- **In history** — `git bisect start; git bisect bad; git bisect good <rev>` finds the commit
  that introduced it in `log₂(n)` steps. Automate with `git bisect run <cmd>`.
- **In a Rust/compiler upgrade** — `cargo bisect-rustc` finds the toolchain version that broke you.
- **In code** — comment out / early-return halves of a function or pipeline to isolate the stage.
- **In a dependency bump** — bisect `Cargo.lock` / the version range.

## Instrument — make the invisible visible

When you can't see state, expose it. Escalate from cheap to heavy:

```rust
dbg!(&value);                       // prints value + file:line, returns it — quick probe
eprintln!("got {x:?} at step {i}"); // ad-hoc trace to stderr
tracing::debug!(?value, "state");   // structured, filterable (RUST_LOG) — keep these
assert!(invariant, "broke: {state:?}"); // catch the violation AT its source, not downstream
RUST_BACKTRACE=1                    // full backtrace on panic; =full for everything
```

Put a probe **before** and **after** the suspected step — the bug is where the value changes
from expected to wrong. Remove `dbg!`/`eprintln!` before committing; keep `tracing` (→
`rust-cloud-native` observability).

## Differential debugging — "works here, not there"

When it works in one place and fails in another, the cause is in the **difference**. List what
differs and bisect *that*: OS/arch, release vs debug, dependency versions, env vars, data,
concurrency level, feature flags. Make the working case fail (or vice-versa) by changing one
difference at a time.

## Intermittent / "heisenbug"

Non-determinism is almost always **shared state, ordering, or timing**:

- Concurrency: a data race or missing synchronization. Run under **Miri** (`cargo +nightly miri
  test`, detects data races — the `rust-miri` agent) and consider `loom` for exhaustive
  interleaving testing of lock-free code (→ `rust-concurrency`).
- Test-order dependence: a test leaking global/file/DB state. Run with `--shuffle` (nightly:
  `cargo +nightly test -- -Z unstable-options --shuffle`) or run each test in isolation; `cargo
  nextest` (→ `rust-testing`) runs tests in separate processes, which also surfaces shared-state
  leaks. Fix by making tests independent.
- Uninitialized/UB: under `unsafe`, "works in debug, breaks in release" smells like UB → Miri
  (→ `rust-unsafe`).
- Time/clock/network: inject the clock, use `tokio::time::pause` instead of real sleeps
  (`tokio::time::pause` and `#[tokio::test(start_paused = true)]` require tokio's `test-util`
  feature).

Make it reproduce *more often* (loop the test, add load, shrink timeouts) before trying to fix —
a bug you can trigger on demand is half-solved.

## Tools

- `RUST_BACKTRACE=1` / `=full` — backtraces on panic.
- `rust-gdb` / `rust-lldb` — breakpoints, inspect state, watchpoints on a changing value.
- `rr` (record/replay) — deterministic replay of a non-deterministic failure; reverse-execute
  from the crash back to the cause. The strongest tool for hard, rare bugs on Linux.
- `cargo test -- --nocapture` — see output from passing-then-failing tests.

## When stuck

Explain the bug out loud / in writing, line by line (rubber-ducking) — the wrong assumption
usually surfaces mid-sentence. If an hour of investigation yields nothing, your *reproduction*
or your *reading of the evidence* is wrong, not the universe — go back to step 1.
