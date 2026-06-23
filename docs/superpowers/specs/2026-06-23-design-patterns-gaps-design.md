# Rust Design Patterns book — coverage gaps

**Date:** 2026-06-23
**Status:** Approved, ready for implementation plan
**Scope:** small — two skill additions plus one reference link. Orthogonal to the CI-aware gate
and elastic review specs; do not fold into them.

## Context

A pass over the [Rust Design Patterns book](https://rust-unofficial.github.io/patterns/)
(rust-unofficial) cross-referenced its full table of contents against craft's skills. The verdict:
craft already covers the review-relevant subset, and its anti-pattern catalog (14 entries in
`rust-idioms/anti-patterns.md`) is richer than the book's (3). The book's GoF pattern catalog
(Command / Interpreter / Strategy / Visitor / Fold / Functional Optics) is deliberately **not**
imported — it is not review-relevant and would violate craft's action-first principle.

Only two genuine gaps surfaced, both small, plus a courtesy reference link.

## Already covered (no change)

`&str`/`&[T]` args, clone-to-satisfy-borrow-checker, `mem::take`/`replace`, Deref polymorphism,
RAII guards, `#[non_exhaustive]` / privacy-for-extensibility, Newtype / Builder / Default /
Constructor, prefer-small-crates, contain-unsafety-in-modules, FFI error/string idioms — all
present across `rust-review`, `rust-idioms`, `rust-ownership`, `rust-traits`, `rust-ecosystem`,
`rust-unsafe`.

## Gaps to fill

### 1. `#![deny(warnings)]` in source — anti-pattern

The book lists `#[deny(warnings)]` as an anti-pattern; craft does not mention it. The nuance worth
capturing: craft's mechanical gate runs `-D warnings` on the **command line** (correct), but
nothing flags the **in-source** crate-root attribute. `#![deny(warnings)]` in a crate makes builds
brittle — a future `rustc`/`clippy` lint turns into a hard build break for the crate and everyone
downstream, and effectively pins the crate to a toolchain.

**Changes:**
- `skills/rust-idioms/anti-patterns.md` — new `## #![deny(warnings)]` section with a Good/Bad pair.
  Bad: `#![deny(warnings)]` at crate root. Good: deny warnings in CI
  (`RUSTFLAGS="-D warnings"` / `cargo clippy -- -D warnings`) and keep the crate lenient. Cite the
  book entry.
- `skills/rust-review/SKILL.md` — MEDIUM tier, "API & quality": a line flagging crate-root
  `#![deny(warnings)]` (or other blanket lint-level attributes) as brittle → move the denial to CI.

### 2. Return consumed arg on error — idiom

The book's "Return consumed arg on error" idiom: when a fallible method consumes an owned value,
return that value back inside the `Err` so the caller can recover or retry without re-acquiring it.
Idiomatic shape: `fn try_x(self) -> Result<Y, (Self, Error)>` (or an error type carrying the
input). Not currently covered in `rust-errors`.

**Change:**
- `skills/rust-errors/SKILL.md` — one short note in the error-design section, with the
  `Result<Y, (Self, Error)>` shape and a one-line rationale (don't strand the caller's owned data
  on failure). Cite the book idiom.

### 3. Reference link — further reading

The book is the canonical community catalog and craft deliberately owns only the action-first,
review-relevant subset. A "Further reading" pointer makes that relationship explicit.

**Change:**
- `skills/rust-idioms/SKILL.md` — a "Further reading" line linking
  https://rust-unofficial.github.io/patterns/, noting craft covers the review-relevant subset and
  the book is the broader catalog (including the GoF patterns craft intentionally does not
  duplicate).

## Non-goals

- Do not import the GoF design-pattern catalog (Command, Interpreter, Strategy, Visitor, Fold,
  Functional Optics) — not review-relevant.
- Do not duplicate idioms already covered; only add the two missing items and the link.
- No change to the review *engine* or the gate — this is skill-content only.

## Risk

Negligible. Three additive edits to skill docs; no behavior change to agents or workflows. Effect
on review recall is near-zero (these cases are already largely caught) — this is catalog
completeness, not a recall fix.
