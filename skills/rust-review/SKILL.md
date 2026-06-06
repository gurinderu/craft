---
name: rust-review
description: Rust code-review rubric — the cargo quality gate, a severity-tiered checklist (safety, error handling, ownership, concurrency, performance, API quality), and the Approve/Warning/Block verdict. Use when reviewing Rust code or a diff, deciding whether changes are mergeable, or before committing. Triggers: review this Rust, code review, rust review, is this mergeable, cargo clippy review, check this PR, unsafe review.
---

# Rust Review

The rubric for reviewing Rust changes: run the mechanical gate first, then read the diff against the severity checklist, then issue a verdict. This is the knowledge; the `rust-reviewer` agent applies it to an actual diff and reports back.

## When to Use

- Reviewing a diff / PR of Rust code
- Deciding whether changes are safe to commit or merge
- A self-check before opening a PR

## Step 1 — Mechanical gate

These are non-negotiable and must pass before human-style review is worth doing. If any fails, stop and report — don't review further.

```bash
cargo fmt --check                  # formatting
cargo clippy --all-targets -- -D warnings   # lints as errors
cargo test                         # behavior (or: cargo nextest run + cargo test --doc)
cargo audit                        # known-vuln advisories   (if cargo-audit present)
cargo deny check                   # licenses + bans + advisories (if cargo-deny present)
```

Setting up / interpreting `cargo audit` + `cargo deny` → `rust-security`.

A green gate is the floor, not the ceiling — it does not mean the code is good, only that it's reviewable.

## Step 2 — Severity checklist

Review the diff against these tiers. This skill owns only the review *process*; cite the owning skill for each fix:

- Safety / injection / secrets / untrusted-input limits → `rust-security`
- `unsafe` / missing `// SAFETY:` → `rust-unsafe`
- Result-vs-panic, typed-error-vs-`anyhow` → `rust-errors`
- `.clone()` / `&str`-vs-`String` / lifetimes → `rust-ownership`
- Blocking-in-async / lock-across-`.await` / deadlock / `Send`+`Sync` → `rust-concurrency`
- Allocation / hot-path / N+1 → `rust-performance`
- Generic code smells / naming / wildcard-match / missing-`///` → `rust-idioms`
- Missing tests → `rust-testing`

### CRITICAL — block on sight

**Safety**
- `unwrap()` / `expect()` / `panic!` / `todo!` / `unreachable!` on a reachable production path
- `unsafe` block without a `// SAFETY:` comment justifying every invariant (SAFETY-comment discipline & UB checklist → `rust-unsafe`)
- SQL/command built by string interpolation of untrusted input (injection)
- User-controlled path used without canonicalize + prefix check (traversal)
- Hardcoded secret / key / token / password in source
- Deserializing untrusted input without size/depth limits

**Error handling**
- Recoverable failure handled with `panic!`/`unwrap` instead of `Result`
- `let _ = result;` silently dropping a `#[must_use]` / error value

### HIGH — block unless justified

**Ownership & lifetimes**
- `.clone()` added to silence the borrow checker without understanding why
- Takes `String` where `&str`/`impl AsRef<str>` suffices; `Vec<T>` where `&[T]` suffices
- Explicit lifetimes where elision applies

**Concurrency**
- Blocking call (`std::thread::sleep`, `std::fs`, blocking I/O) inside an `async` fn
- Unbounded channel without justification (prefer bounded back-pressure)
- Lock held across an `.await`
- Inconsistent lock acquisition order (deadlock risk)
- Missing `Send`/`Sync` where the type crosses threads

**Test coverage** (cross-check with the `rust-testing` skill)
- New error path or branch with no test
- Bug fix landed without a regression test reproducing it

### MEDIUM — warn, may merge

**Performance**
- Allocation inside a hot loop; `to_string()`/`to_owned()` where a borrow works
- `Vec::new()` + push loop where the size is known (`with_capacity`)
- N+1 queries / repeated work in a loop

**API & quality**
- Library returning `Box<dyn Error>` / `anyhow::Error` instead of a typed error (API-design concern → `rust-errors`)
- Function > ~50 lines or nesting > 4 levels
- Wildcard `_ =>` on a business enum (hides new variants — prefer exhaustive)
- `pub` item without a `///` doc
- `#[allow(...)]` suppressing a lint without a justifying comment

## Step 3 — Verdict

| Verdict | When |
|---|---|
| **Approve** ✅ | gate green, no CRITICAL or HIGH |
| **Warning** ⚠️ | gate green, MEDIUM only — list them, leave merge to author |
| **Block** ⛔ | gate red, or any CRITICAL/HIGH — list each with file:line and the fix |

Report findings as `severity · file:line · what · why · fix`. Be specific and cite the line; a finding without a location isn't actionable.

## Boundaries

- *How* to write the missing tests → `rust-testing` skill (this rubric only flags that they're missing).
- This skill judges; it does not rewrite. Propose the fix, let the author apply it.
