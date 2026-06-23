# Rust Design Patterns book — coverage gaps

**Date:** 2026-06-23
**Status:** Approved, ready for implementation plan
**Scope:** small — three skill additions, one reference link, and an OOP→Rust Rosetta bridge
(GoF + SOLID). Orthogonal to the CI-aware gate and elastic review specs; do not fold into them.

## Context

A pass over the [Rust Design Patterns book](https://rust-unofficial.github.io/patterns/)
(rust-unofficial) cross-referenced its full table of contents against craft's skills. The verdict:
craft already covers the review-relevant subset, and its anti-pattern catalog (14 entries in
`rust-idioms/anti-patterns.md`) is richer than the book's (3). The book's GoF pattern catalog
(Command / Interpreter / Strategy / Visitor / Fold / Functional Optics) is **not** imported
wholesale — craft organizes by *mechanism*, not by GoF taxonomy, and most of these patterns are
already present under their Rust mechanism (Strategy → dispatch choice, Builder/Newtype/RAII →
their own skills). A full GoF catalog would create a second organizing axis that cross-cuts and
duplicates. Importing it into the review rubric is also rejected: GoF patterns are
solution-structure guidance, not diff-level defects.

Two genuine content gaps surfaced (both small) plus a courtesy reference link, and — to bridge for
readers who think in OOP terms — one Rosetta section mapping both GoF patterns and SOLID principles
to their Rust form, plus the one real *mechanism* gap (Visitor). SOLID gets the same treatment as
GoF: not a dedicated skill (it cross-cuts craft's mechanism organization), but a mapping bridge;
its DIP principle is already named explicitly in `rust-architecture`.

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

### 4. OOP design vocabulary → Rust — one Rosetta bridge (GoF + SOLID) + the Visitor gap

craft is organized by mechanism, so most GoF patterns and SOLID principles already live in it under
their Rust form. For readers who think in OOP terms (most engineers), add one opinionated bridge
section — and fill the one mechanism actually missing.

**4a. Rosetta bridge.** One section in `skills/rust-idioms/patterns.md`, "OOP design vocabulary in
Rust", holding two small tables with columns `name · Rust form · owning craft skill · what to
avoid`. It is a discoverability bridge, not new content — each row points at the skill that owns
the mechanism and states craft's opinion.

- **GoF table.** Cover at least: Strategy, State, Command, Observer, Visitor, Builder, Newtype,
  RAII guard, Fold, Generics-as-Type-Classes, plus the FFI Object-Based-API / Wrapper pair. Example
  row: *Strategy → just choose a dispatch mechanism; do not build an interface hierarchy →
  `rust-traits`*. Mark the niche ones craft intentionally omits (Interpreter, Functional Optics) as
  "out of scope — see the book."
- **SOLID table.** Five rows:
  - **S** (Single Responsibility) → cohesion; the god-module / giant-function checks already in
    `rust-architecture-review` and `rust-review`.
  - **O** (Open/Closed) → the **expression problem**: enum (closed to types, open to operations)
    vs trait (open to types, closed to operations); choose by the axis you expect to extend →
    `rust-traits` (ties to the Visitor gap in 4b).
  - **L** (Liskov) → **largely dissolves** without implementation inheritance; becomes "honor the
    trait's documented contract / laws" (total `Ord`, consistent `Hash`/`Eq`) → `rust-traits` /
    `rust-idioms`.
  - **I** (Interface Segregation) → many small focused traits (std splits `Read`/`Write`/`Seek`);
    object-safety pushes the same way → `rust-traits`.
  - **D** (Dependency Inversion) → ports as traits, dependency flow toward the domain → already
    named in `rust-architecture` (point at it, do not restate).

**4b. Visitor — the real mechanism gap.** Operations over a set of variants. The Rust answer:
`match` on the enum for a **closed** set (add an operation freely; adding a variant is a breaking
change you *want* the compiler to flag); a **visitor trait** (double dispatch) for an **open /
extensible** set. A short section in `skills/rust-traits/dispatch.md` (it already owns the
static/dynamic/enum dispatch decision), cross-linked to `rust-macros` for the AST-traversal case.
The Rosetta table's Visitor row points here.

## Non-goals

- Do not import the full GoF catalog as standalone pattern entries (Command, Interpreter, Strategy,
  Fold, Functional Optics) — the Rosetta bridge maps them by mechanism instead.
- No dedicated SOLID skill/subfile — SOLID is an OOP framing by acronym; the Rosetta bridge maps it
  to the mechanisms craft already owns (DIP points at `rust-architecture`, not restated).
- GoF and SOLID stay out of the review rubric — solution-structure guidance, not diff-level
  defects.
- Do not duplicate idioms already covered; only add the two content gaps, the Visitor mechanism,
  the Rosetta table, and the link.
- No change to the review *engine* or the gate — this is skill-content only.

## Risk

Negligible. All additive edits to skill docs (`rust-idioms`, `rust-review`, `rust-errors`,
`rust-traits`); no behavior change to agents or workflows. Effect on review recall is near-zero
(these cases are already largely caught) — this is catalog completeness and discoverability, not a
recall fix.
