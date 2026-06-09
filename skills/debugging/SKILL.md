---
name: debugging
description: Rust debugging toolbox — the concrete techniques for reproducing, localizing, and explaining a Rust bug (minimal repro, git bisect / cargo bisect-rustc, dbg!/tracing/RUST_BACKTRACE instrumentation, Miri/loom for heisenbugs, rust-gdb/rr). The general method (root cause before fix) lives in superpowers:systematic-debugging. Use for any Rust bug, panic, test failure, crash, or flaky/intermittent behavior. Triggers: bug, debug, test failure, crash, panic, regression, unexpected behavior, root cause, repro, reproduce, bisect, heisenbug, RUST_BACKTRACE, cargo bisect, why is this failing, it works sometimes.
---

# Debugging (Rust)

The **method** is general and lives in `superpowers:systematic-debugging` — follow it: find the
root cause before you touch the code (the iron law: *no fix without a root cause you can
explain*), work the OBSERVE → REPRODUCE → LOCALIZE → EXPLAIN → FIX → VERIFY loop, and avoid the
anti-patterns (shotgun debugging, fix-and-pray, ignoring the trace, no regression test).

This skill adds the **Rust-specific toolbox** for the middle of that loop. Full detail in
[techniques.md](techniques.md).

## Read the error first

The single highest-yield habit: read the whole error message and stack trace before doing
anything. Rust's errors (and `RUST_BACKTRACE=1` / `=full`) are unusually precise — they usually
name the file, line, and often the cause. Don't pattern-match the first word and jump.

## Rust toolbox (→ techniques.md)

- **Shrink the repro** — delta-debug the input; a failing `proptest`/`quickcheck` hands you a
  minimal counterexample (→ `rust-testing`).
- **Bisect** — `git bisect run <cmd>` for the offending commit; `cargo bisect-rustc` for a
  toolchain regression.
- **Instrument** — escalate `dbg!` → `eprintln!` → `tracing::debug!(?x)` → `assert!`;
  `RUST_BACKTRACE=1` for the panic path. Remove `dbg!`/`eprintln!` before committing; keep
  `tracing` (→ `rust-cloud-native`).
- **Heisenbugs** — non-determinism is shared state / ordering / timing: run under **Miri** (data
  races — the `rust-miri` agent) or `loom`; `cargo nextest`'s process isolation surfaces
  test-order leaks; inject the clock with `tokio::time::pause` (→ `rust-concurrency`).
- **Heavy tools** — `rust-gdb`/`rust-lldb`, and `rr` for deterministic record/replay of rare
  failures.

## Boundaries

- Full technique detail → [techniques.md](techniques.md).
- The general method, iron law, the loop, and anti-patterns → `superpowers:systematic-debugging`.
- Confirming the fix with evidence → `superpowers:verification-before-completion` (the Rust
  "what proves what" commands → `rust-review`).
- A panic-where-a-`Result`-belonged / error-design issue → `rust-errors`.
- Intermittent / ordering / data-race bugs → `rust-concurrency` (and Miri via the `rust-miri`
  agent).
- "Slow", not "wrong" → `rust-performance` (profile, don't guess).
- Symptom-patching (e.g. `unwrap_or_default()` to hide a `None`) is a finding in → `rust-review`.
