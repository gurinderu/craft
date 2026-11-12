---
name: refactoring
description: >-
  Disciplined refactoring — change structure without changing behavior, in tiny reversible steps under green tests. Use when restructuring code, paying down a smell, or preparing messy code for a change. Language-agnostic. Triggers: refactor, code smell, technical debt, extract function, make this testable.
---

# Refactoring

Refactoring is changing *how* code is structured without changing *what* it does. The discipline
is what separates it from "rewriting and hoping": **tiny reversible steps, behavior held
constant, tests green the whole way.**

## The two rules

```
1. NEVER refactor and change behavior in the same step.
2. NEVER refactor without a test safety net that's currently GREEN.
```

Mixing structure and behavior changes means a failing test can't tell you which one broke it.
Refactoring without tests is just editing — you have no way to know you preserved behavior.

## When to Use

- Restructuring code that works but is hard to read/change
- Paying down a specific smell
- "Making the change easy, then making the easy change" — refactor *first* to fit a new feature,
  then add the feature (two separate steps/commits)

Don't refactor on a red bar, mid-debugging, or "while I'm in here" alongside a feature — separate
the commits.

## The loop

```
1. GREEN    — confirm the tests pass now. No tests? Write characterization
              tests first that pin current behavior.
2. ONE STEP — apply a single, named transformation (below).
3. GREEN    — run the tests again immediately. Still green → keep; red → revert this step.
4. COMMIT   — small commits between steps so every step is reversible.
5. REPEAT   — until the smell is gone.
```

Small steps make mistakes cheap: when a step goes red, you revert seconds of work, not an hour's.

## Characterization tests first

Refactoring legacy code with no tests? Don't trust your reading of it — pin its *actual* current
behavior with tests first (even ugly ones, even snapshot/`insta` tests of the output), then
refactor under them. The safety net is the precondition, not an afterthought (→ `rust-testing`).

## Named transformations

Refactor by recognizable moves, not freehand edits:

- **Extract function / variable** — name a chunk of logic or a sub-expression.
- **Inline** — the reverse, when the indirection costs more than it gives.
- **Rename** — make the name tell the truth (the cheapest, highest-value refactor).
- **Introduce type** — replace a primitive/`bool`/stringly-typed value with a newtype/enum (→
  `rust-traits`, `rust-idioms`).
- **Replace conditional with dispatch** — a sprawling `match`/`if` on a tag → enum dispatch or a
  trait (→ `rust-traits`).
- **Extract trait / module** — pull a seam so the unit becomes testable (→ `rust-architecture`).
- **Slide statements / split loop** — group related code; one loop per concern.

## Rust-specific

- Let the compiler drive: rename/extract and lean on `rustc`'s errors to find every call site —
  the type system makes many refactors mechanically safe.
- `cargo clippy` *suggests* refactors (needless clones, complex matches) — `--fix` applies the
  safe ones (→ `rust-idioms`).
- Restructuring to satisfy the borrow checker (split borrows, ownership moves) is its own kind of
  refactor → `rust-ownership`.
- Keep behavior identical: don't "improve" an error type or a public signature mid-refactor —
  that's a behavior/API change, do it separately (→ `rust-errors`, semver in `rust-ecosystem`).

## Boundaries

- The test safety net (characterization, snapshot, property) → `rust-testing`; specs as the
  behavior contract → `specs`.
- Which smells to target / the Good→Bad catalog → `rust-idioms` (anti-patterns).
- Extracting seams/ports as a larger structural move → `rust-architecture`.
