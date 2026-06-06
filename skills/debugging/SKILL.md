---
name: debugging
description: Systematic debugging — find the root cause before changing anything, with concrete techniques (minimal repro, bisection, instrumentation, differential analysis). Use for any bug, test failure, crash, or unexpected behavior, before proposing a fix. Language-agnostic, with Rust hooks. Triggers: bug, debug, test failure, crash, panic, regression, unexpected behavior, root cause, repro, reproduce, bisect, heisenbug, why is this failing, it works sometimes.
---

# Debugging

Guessing wastes time and breeds new bugs. The discipline: **understand the cause before you
touch the code.** A fix you can't explain isn't a fix — it's a coincidence. Concrete techniques
are in [techniques.md](techniques.md).

## The iron law

```
NO FIX WITHOUT A ROOT CAUSE YOU CAN EXPLAIN
```

If you can't say *why* the bug happens and *why* your change fixes it, you haven't debugged —
you've gambled. This holds hardest exactly when it's tempting to skip: under time pressure, on
"obviously trivial" bugs, after several failed attempts.

## When to Use

Any technical surprise: test failure, panic/crash, wrong output, perf cliff, build error,
flaky/intermittent behavior. Especially when a previous fix didn't hold, or you don't fully
understand the issue.

## The loop

```
1. OBSERVE   — read the actual error/stack trace, fully. Note exact message, file:line, codes.
2. REPRODUCE — trigger it reliably and as small as possible. No repro → gather data, don't guess.
3. LOCALIZE  — narrow WHERE it happens: bisect (code/history/input), differential, instrument.
4. EXPLAIN   — form a hypothesis that accounts for ALL the evidence; test the hypothesis directly.
5. FIX       — make the smallest change the explanation demands; add a regression test that was RED.
6. VERIFY    — re-run the failing case AND the suite; confirm with evidence (→ verification).
```

Each step gates the next. You don't fix at step 5 until the explanation at step 4 predicts the
behavior you've seen. Techniques for steps 2–4 → [techniques.md](techniques.md).

## Read the error first

The single highest-yield habit: **read the whole error message and stack trace before doing
anything.** It usually names the file, line, and often the cause. Don't pattern-match the first
word and jump — Rust's errors (and `RUST_BACKTRACE=1`) are unusually precise; use them.

## Reproduce before you reason

A bug you can't reproduce, you can't fix — you can only hope. Get a **reliable, minimal** repro:
fixed inputs, one failing test, deterministic. Shrinking the repro often reveals the cause by
itself. If it's intermittent, that's data (a race, ordering, or external state — see
techniques.md and `rust-concurrency`).

## Don't confuse symptom with cause

A `None` unwrap panics at line 50, but the bug is that line 30 produced `None`. Fix the cause,
not the crash site. Adding `unwrap_or_default()` at line 50 hides a real bug — that's a symptom
patch, and it's a finding in `rust-review`.

## Anti-patterns

- **Shotgun debugging** — changing several things at once. Change one variable at a time or you
  learn nothing from the result.
- **Fix-and-pray** — editing until the symptom disappears without an explanation. The bug isn't
  gone, it's hidden; it returns as a worse one.
- **Ignoring the trace** — skimming past the error to your assumption.
- **No regression test** — fixing without a test that reproduced the bug means it can silently
  come back (→ `rust-testing`).

## Boundaries

- Concrete techniques (repro shrinking, bisection, instrumentation, differential, races) →
  [techniques.md](techniques.md).
- Confirming the fix with evidence → `verification`.
- The bug is a panic-where-a-Result-belonged / error-design issue → `rust-errors`.
- Intermittent/ordering/data-race bugs → `rust-concurrency` (and Miri via the `rust-miri` agent).
- "Slow", not "wrong" → `rust-performance` (profile, don't guess — same spirit).
