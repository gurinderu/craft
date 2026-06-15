---
name: rust-review
description: Rust code-review rubric — the cargo quality gate, a severity-tiered checklist (safety, error handling, ownership, concurrency, performance, API quality), a public-API design pass against the Rust API Guidelines, the Approve/Warning/Block verdict, how to request a craft review (dispatch the rust-reviewer/rust-security-scanner/rust-miri agents with a crafted brief), and the Rust "what proves what" table for verifying a claim. Use when reviewing Rust code or a diff, requesting a review, deciding whether changes are mergeable, before committing or merging, reviewing a library's public API, or to confirm a claim with the right cargo command. Triggers: code review, ready for review, is this mergeable, dispatch reviewer, check this PR, public API, API guidelines, what proves done.
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

### Public-API diffs — the API-design pass

When the diff changes a **public API** (a library crate, a published `pub` surface), also run the
condensed Rust API Guidelines checklist → [api-design.md](api-design.md). It catches the
library-author concerns the general checklist above doesn't — missing common-trait impls,
`Deref`-as-inheritance, out-parameters, unsealed extensible traits, leaking unstable deps, absent
`CHANGELOG`/metadata. Each item points at the craft skill that owns the fix. Skip it for
application-internal code.

## Step 3 — Verdict

| Verdict | When |
|---|---|
| **Approve** ✅ | gate green, no CRITICAL or HIGH |
| **Warning** ⚠️ | gate green, MEDIUM only — list them, leave merge to author |
| **Block** ⛔ | gate red, or any CRITICAL/HIGH — list each with file:line and the fix |

Report findings as `severity · file:line · what · why · fix`. Be specific and cite the line; a finding without a location isn't actionable.

## Requesting a review & acting on the verdict

Review early and often — small reviews catch issues while they're cheap; one giant review at the end catches them after they've compounded. Request after a feature or meaningful unit of work, before merging, when stuck, or after a complex bug fix. The generic *discipline* (request early/often) lives in `superpowers:requesting-code-review`; this section is craft's Rust-agent wiring.

Hand the reviewer a **crafted brief**, not your chat history:

- the **diff range** — `BASE..HEAD` (`git merge-base main HEAD` and `HEAD`); the agent derives the exact range itself via `git diff --merge-base main`, so the SHAs are just for your reference;
- **what it should do** — the requirement/spec it's meant to satisfy (→ `specs`);
- **what you built** — a one-paragraph summary.

In craft, dispatch the agents with that brief:

- **`rust-reviewer`** — runs the cargo gate + this rubric → Approve/Warning/Block.
- **`rust-security-scanner`** — security-sensitive changes (deps, `unsafe`, input handling) → `rust-security` verdict.
- **`rust-miri`** — when the change touches `unsafe` (→ `rust-unsafe`).

**Acting on the verdict** — working a set of findings to green (triage accept/reject/defer/needs-decision, order blocking → simple → complex, fix, verify, re-review, close the loop on GitHub) is its own discipline → `addressing-findings`; for a large batch it dispatches the `triage-findings` workflow. The generic "act without performing" method (verify-before-implement, no performative agreement, reasoned pushback) → `superpowers:receiving-code-review`.

## Proving a claim — what proves what

The *discipline* — evidence before any "done / passes / fixed / works", no claim without a fresh run you read this session — lives in `superpowers:verification-before-completion`. The Rust commands that actually prove each claim:

| Claim | Proof (run it) | Not proof |
|---|---|---|
| tests pass | `cargo test` / `cargo nextest run` → 0 failed | "should pass", an earlier run |
| doctests pass | `cargo test --doc` | unit tests passing |
| lint clean | `cargo clippy --all-targets -- -D warnings` → exit 0 | `cargo check` passing |
| formatted | `cargo fmt --check` | "I ran fmt earlier" |
| it builds | `cargo build --release` → exit 0 | clippy passing |
| bug fixed | re-run the case that reproduced it → passes | code changed, "looks right" |
| regression test works | saw it RED before the fix, GREEN after | it's green now |
| no vulns | `cargo audit` / `cargo deny check` clean | "deps look fine" |
| coverage target met | `cargo llvm-cov --fail-under-lines N` | tests pass |
| an agent finished | read the actual diff / its output | the agent said "success" |
| requirements met | check each one against the spec | tests pass |

State the claim **with** the evidence, or state the real status with the evidence. An earlier run, a "should pass", or a subagent's self-report is not evidence.

## Boundaries

- *How* to write the missing tests → `rust-testing` skill (this rubric only flags that they're missing).
- This skill judges; it does not rewrite. Propose the fix, let the author apply it.
- The generic review/verify *discipline* → `superpowers:requesting-code-review`, `superpowers:receiving-code-review`, `superpowers:verification-before-completion`.
