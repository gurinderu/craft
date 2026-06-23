# Rust Design Patterns Coverage Gaps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the two content gaps the Rust Design Patterns book exposed (`#![deny(warnings)]`, return-consumed-arg-on-error), add a GoF+SOLID Rosetta bridge and the Visitor mechanism, and link the book as further reading.

**Architecture:** Six additive edits to existing skill markdown files. No code, no tests, no agent/workflow change. Each edit matches its file's established voice (Good/Bad code with `// ✗` / `// ✓` comments and `→ skill` pointer arrows; decision tables) and ends in its own commit.

**Tech Stack:** Markdown skill docs only. Verification is `rg` for the exact new phrase plus a check that any relative cross-link resolves to a real file. There is no pytest/build cycle for this work — do **not** invent one.

## Global Constraints

- Skill files live under `skills/<name>/`; this plan touches `rust-idioms`, `rust-review`, `rust-errors`, `rust-traits` only.
- Additive only — do not rewrite or reorder existing sections; append new sections at the documented anchor.
- Match the target file's voice: anti-patterns/patterns use a `## Heading` + fenced Good/Bad block (`// ✗`, `// ✓`) + a short prose line ending in a `→ owner` pointer.
- Relative links from a file in `skills/rust-idioms/` reach a sibling as `name.md` and another skill as `../rust-traits/dispatch.md`.
- Commit messages are written as the user — **no Claude/Claude Code attribution, no Co-Authored-By trailer**.
- Tasks are ordered so each cross-reference target exists before the task that links to it. Implement in order.

---

### Task 1: `#![deny(warnings)]` anti-pattern

**Files:**
- Modify: `skills/rust-idioms/anti-patterns.md` (append after the last section, "Surprising operator overloads", which ends the file)

**Interfaces:**
- Produces: a `## Crate-level \`#![deny(warnings)]\`` section that Task 2 (rust-review rubric) points at.

- [ ] **Step 1: Read the anchor**

Run: `tail -20 skills/rust-idioms/anti-patterns.md`
Confirm the file ends with the "## Surprising operator overloads" section (the new section appends after it).

- [ ] **Step 2: Append the new section**

Append to the end of `skills/rust-idioms/anti-patterns.md`:

````markdown

## Crate-level `#![deny(warnings)]`

```rust
#![deny(warnings)]   // ✗ in lib.rs/main.rs — a future rustc/clippy lint turns into a hard build break
```
```bash
# ✓ deny warnings where the toolchain is fixed — in CI, not baked into the source
RUSTFLAGS="-D warnings" cargo build
cargo clippy --all-targets -- -D warnings
```

Baking `#![deny(warnings)]` into a crate pins it to a toolchain: the next compiler or clippy
release can add a lint that becomes a hard error for you *and* everyone downstream, with no code
change on their part. Keep the crate lenient and enforce `-D warnings` in CI, where the toolchain
is pinned. → Rust Design Patterns (anti-pattern: `#[deny(warnings)]`).
````

- [ ] **Step 3: Verify the content landed**

Run: `rg -n "Crate-level .#!\[deny\(warnings\)\]." skills/rust-idioms/anti-patterns.md`
Expected: one match (the new heading).

- [ ] **Step 4: Commit**

```bash
git add skills/rust-idioms/anti-patterns.md
git commit -m "docs(rust-idioms): add crate-level deny(warnings) anti-pattern"
```

---

### Task 2: Flag crate-root `#![deny(warnings)]` in the review rubric

**Files:**
- Modify: `skills/rust-review/SKILL.md` (the MEDIUM tier, "API & quality" bullet list — currently ends with the `#[allow(...)]` bullet around line 89)

**Interfaces:**
- Consumes: the anti-pattern section from Task 1 (the bullet points readers at `rust-idioms`).

- [ ] **Step 1: Read the anchor**

Run: `rg -n "allow\(\.\.\.\)\` suppressing a lint" skills/rust-review/SKILL.md`
Confirm the `#[allow(...)]` bullet is the last bullet under "**API & quality**".

- [ ] **Step 2: Add the bullet**

In `skills/rust-review/SKILL.md`, immediately after the line:

```
- `#[allow(...)]` suppressing a lint without a justifying comment
```

add:

```
- Crate-root `#![deny(warnings)]` (or other blanket lint-level attributes) — brittle: a new compiler/clippy lint becomes a hard build break for the crate and its dependents → move the denial to CI (`rust-idioms` anti-patterns)
```

- [ ] **Step 3: Verify**

Run: `rg -n "Crate-root .#!\[deny\(warnings\)\]." skills/rust-review/SKILL.md`
Expected: one match.

- [ ] **Step 4: Commit**

```bash
git add skills/rust-review/SKILL.md
git commit -m "docs(rust-review): flag crate-root deny(warnings) as MEDIUM"
```

---

### Task 3: Return the consumed value on failure (rust-errors)

**Files:**
- Modify: `skills/rust-errors/SKILL.md` (insert a new `##` section after "## The `?` operator", before "## Decision: which error crate?")

- [ ] **Step 1: Read the anchor**

Run: `rg -n "^## The .\?. operator|^## Decision: which error crate" skills/rust-errors/SKILL.md`
Confirm "## The `?` operator" precedes "## Decision: which error crate?" — the new section goes between them.

- [ ] **Step 2: Insert the section**

In `skills/rust-errors/SKILL.md`, after the `?`-operator section's closing paragraph (the line ending "`?` also works in functions returning `Option`.") and before "## Decision: which error crate?", insert:

````markdown
## Return the consumed value on failure

When a fallible method takes an owned value *by value* (often `self`) and can fail, hand the value
back inside the `Err` so the caller can retry or recover without re-acquiring it:

```rust
fn connect(self) -> Result<Live, ConnectError>;          // ✗ on failure the caller has lost `self`
fn connect(self) -> Result<Live, (Self, ConnectError)>;  // ✓ failure returns the value to retry with
```

The same shape works for any owned input (a `Vec`, a buffer, a builder). Reserve it for values that
are expensive or impossible to reconstruct — for cheap `Copy`/clonable inputs it is just noise.
→ Rust Design Patterns (idiom: "Return consumed arg on error").

````

- [ ] **Step 3: Verify**

Run: `rg -n "Return the consumed value on failure" skills/rust-errors/SKILL.md`
Expected: one match.

- [ ] **Step 4: Commit**

```bash
git add skills/rust-errors/SKILL.md
git commit -m "docs(rust-errors): add return-consumed-value-on-failure idiom"
```

---

### Task 4: Visitor mechanism (rust-traits dispatch)

**Files:**
- Modify: `skills/rust-traits/dispatch.md` (append after the final "## Choosing" section)

**Interfaces:**
- Produces: a `## Operations over a variant set — the Visitor question` section that Task 5's Rosetta GoF "Visitor" row links to.

- [ ] **Step 1: Read the anchor**

Run: `tail -15 skills/rust-traits/dispatch.md`
Confirm the file ends with the "## Choosing" section and its rules-of-thumb paragraph.

- [ ] **Step 2: Append the Visitor section**

Append to the end of `skills/rust-traits/dispatch.md`:

````markdown

## Operations over a variant set — the Visitor question

When you have a set of variants and want to run operations over them, the dispatch choice above
decides how — this is the classic Visitor pattern, and Rust answers it by whether the set is
**closed** or **open**:

- **Closed set → `match` on an enum.** Add a new operation freely (just write another function that
  matches). Adding a variant is a compile error at every `match` — a breaking change you *want* the
  compiler to surface. This is enum dispatch (above); no visitor trait needed.

```rust
enum Expr { Lit(i64), Add(Box<Expr>, Box<Expr>) }

fn eval(e: &Expr) -> i64 {                  // a new operation is just a new fn — no trait, no double dispatch
    match e {
        Expr::Lit(n) => *n,
        Expr::Add(a, b) => eval(a) + eval(b),
    }
}
```

- **Open set → a visitor trait (double dispatch).** When external code must add new node types
  without touching yours, expose a `Visitor` trait and have each node call back into it: new node
  types implement `accept`, new operations are new `Visitor` impls.

```rust
trait Visitor { fn visit_lit(&mut self, n: i64); fn visit_add(&mut self, a: &dyn Node, b: &dyn Node); }
trait Node    { fn accept(&self, v: &mut dyn Visitor); }
```

Reach for the trait only when the set is genuinely open — for your own closed AST a plain `match`
is simpler and exhaustiveness-checked. For walking large or generated ASTs, a derive macro can
generate the `accept`/visit plumbing → `rust-macros`.
````

- [ ] **Step 3: Verify**

Run: `rg -n "the Visitor question" skills/rust-traits/dispatch.md`
Expected: one match.

- [ ] **Step 4: Commit**

```bash
git add skills/rust-traits/dispatch.md
git commit -m "docs(rust-traits): add Visitor — closed match vs open visitor trait"
```

---

### Task 5: GoF + SOLID Rosetta bridge (rust-idioms patterns)

**Files:**
- Modify: `skills/rust-idioms/patterns.md` (append after the final "## Plug into std" section)

**Interfaces:**
- Consumes: the Visitor section from Task 4 (`../rust-traits/dispatch.md`) and the Deref anti-pattern (`anti-patterns.md`) — both linked from table rows, so both must exist first.
- Produces: an `## OOP design vocabulary in Rust (GoF & SOLID)` section that Task 6 (further-reading link) references.

- [ ] **Step 1: Read the anchor and confirm link targets exist**

Run: `tail -8 skills/rust-idioms/patterns.md && ls skills/rust-idioms/anti-patterns.md skills/rust-traits/dispatch.md`
Confirm the file ends with "## Plug into std…" and both link targets exist.

- [ ] **Step 2: Append the Rosetta section**

Append to the end of `skills/rust-idioms/patterns.md`:

````markdown

## OOP design vocabulary in Rust (GoF & SOLID)

craft is organized by *mechanism*, not by GoF/SOLID name — so the patterns you know from OOP mostly
already live here under their Rust form. These tables are a bridge: they map the name you'd search
for to how Rust expresses it and the craft skill that owns it. The fuller catalog (and the patterns
craft deliberately skips) is in the
[Rust Design Patterns book](https://rust-unofficial.github.io/patterns/).

### GoF patterns → Rust

| GoF pattern | Rust form | Owns it | What to avoid |
|---|---|---|---|
| Strategy | choose a dispatch mechanism (generics / `dyn` / enum / a `fn`/closure field) | `rust-traits` (dispatch) | a `StrategyFactory` interface hierarchy — pick a dispatch and move on |
| State | an enum + `match`, or typestate for compile-checked transitions | `rust-traits` (type-driven) | a `dyn State` that downcasts to recover its type |
| Command | an enum of actions (+ `match`), or a boxed `FnOnce` | `rust-traits` (dispatch) | a `Command` trait with one `execute()` impl per verb when an enum fits |
| Observer | channels (`mpsc`/broadcast) or a `Vec` of callbacks | `rust-concurrency` | a self-referential observer graph fighting the borrow checker |
| Visitor | `match` for a closed variant set; a visitor trait for an open one | `rust-traits` — see [dispatch.md](../rust-traits/dispatch.md) | a visitor trait when a plain `match` over your own enum is enough |
| Builder | chainable `with_*` methods; typestate builder for required fields | `rust-idioms` / `rust-traits` | a builder for a struct `Default` + struct-update already handles |
| Newtype | a tuple struct wrapping one field | `rust-traits` (type-driven) | `Deref` to fake inheritance (see [anti-patterns.md](anti-patterns.md)) |
| RAII guard | a value whose `Drop` releases the resource | `rust-ownership` (pointers) | a manual `close()`/`release()` the caller must remember |
| Fold / accumulator | `Iterator::fold` / `try_fold` | `rust-idioms` / `rust-performance` | a hand-rolled accumulator loop where an iterator reads clearer |
| Generics as type classes | generic bounds `T: Trait` | `rust-traits` | reaching for `dyn` when a generic bound expresses the constraint |
| Object-Based API / Wrapper (FFI) | an opaque handle + a safe wrapper over the raw pointer | `rust-unsafe` (ffi) | leaking raw pointers across the FFI boundary |

Intentionally out of scope (use the book): **Interpreter**, **Functional Optics** — niche enough
that craft doesn't carry them.

### SOLID principles → Rust

| Principle | Rust form | Owns it | What to avoid |
|---|---|---|---|
| **S** — Single Responsibility | module/type cohesion; flagged as god-modules and giant functions in review | `rust-architecture-review`, `rust-review` | a `utils`/`manager` module that accretes unrelated responsibilities |
| **O** — Open/Closed | the **expression problem**: an enum is closed to new types but open to new operations; a trait is open to new types but closed to new operations — pick by the axis you expect to extend | `rust-traits` (dispatch; ties to Visitor) | forcing `dyn` extensibility on a set that is actually closed, or vice-versa |
| **L** — Liskov substitution | largely *dissolves* — Rust has no implementation inheritance; what remains is "honor the trait's documented contract/laws" (a total `Ord`, a `Hash` consistent with `Eq`) | `rust-traits`, `rust-idioms` | an impl that breaks the trait's laws (e.g. a partial order claiming to be total `Ord`) |
| **I** — Interface Segregation | many small, focused traits (std splits `Read`/`Write`/`Seek`); object-safety pushes the same way | `rust-traits` | one fat trait forcing impls to stub methods they don't support |
| **D** — Dependency Inversion | ports as traits: the domain depends on a trait, adapters implement it, dependencies flow toward the domain | `rust-architecture` (ports) | the domain `use`-ing a concrete adapter (sqlx, axum) directly |
````

- [ ] **Step 3: Verify the content and links**

Run: `rg -n "OOP design vocabulary in Rust" skills/rust-idioms/patterns.md`
Expected: one match.
Run: `rg -n "the Visitor question" skills/rust-traits/dispatch.md && rg -n "Deref. to fake inheritance" skills/rust-idioms/anti-patterns.md`
Expected: a match in each (the two link targets resolve).

- [ ] **Step 4: Commit**

```bash
git add skills/rust-idioms/patterns.md
git commit -m "docs(rust-idioms): add GoF+SOLID Rosetta bridge to patterns"
```

---

### Task 6: Further-reading link to the book (rust-idioms SKILL)

**Files:**
- Modify: `skills/rust-idioms/SKILL.md` (append a `## Further reading` section after the final "## Boundaries" section)

**Interfaces:**
- Consumes: the Rosetta section from Task 5 (the link points at `patterns.md`).

- [ ] **Step 1: Read the anchor**

Run: `tail -10 skills/rust-idioms/SKILL.md`
Confirm the file ends with the "## Boundaries" bullet list.

- [ ] **Step 2: Append the section**

Append to the end of `skills/rust-idioms/SKILL.md`:

````markdown

## Further reading

- [Rust Design Patterns](https://rust-unofficial.github.io/patterns/) (rust-unofficial) — the
  broader community catalog of idioms, design patterns, and anti-patterns. craft owns the
  action-first, review-relevant subset; the book covers the rest, including the GoF patterns craft
  deliberately doesn't duplicate (mapped by mechanism in the GoF/SOLID Rosetta in
  [patterns.md](patterns.md)).
````

- [ ] **Step 3: Verify the content and link**

Run: `rg -n "Further reading" skills/rust-idioms/SKILL.md && rg -n "OOP design vocabulary in Rust" skills/rust-idioms/patterns.md`
Expected: a match in each (the link target resolves).

- [ ] **Step 4: Commit**

```bash
git add skills/rust-idioms/SKILL.md
git commit -m "docs(rust-idioms): link Rust Design Patterns book as further reading"
```

---

## Notes for the implementer

- The four `→ Rust Design Patterns (…)` / book-link mentions are deliberate citations of the source the gap came from — keep them.
- If `rg` in a verify step finds zero matches, the append didn't land (or the heading text drifted from what's written here) — fix before committing; never commit an unverified edit.
