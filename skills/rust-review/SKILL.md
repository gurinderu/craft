---
name: rust-review
description: >-
  Rust code-review rubric — the cargo quality gate, a severity-tiered checklist (safety, error handling, ownership, concurrency, performance, API quality), a public-API design pass against the Rust API Guidelines, the Approve/Warning/Block verdict, how to request a craft review (dispatch the rust-reviewer/rust-security-scanner/rust-miri agents with a crafted brief), and the Rust "what proves what" table for verifying a claim. Use when reviewing Rust code or a diff, requesting a review, deciding whether changes are mergeable, before committing or merging, reviewing a library's public API, or to confirm a claim with the right cargo command. Triggers: code review, ready for review, is this mergeable, dispatch reviewer, check this PR, public API, API guidelines, what proves done.
---

# Rust Review

The rubric for reviewing Rust changes: run the mechanical gate first, then read the diff against the severity checklist, then issue a verdict. This is the knowledge; the `rust-reviewer` agent applies it to an actual diff and reports back.

**The review entry point is the `rust-review` workflow** (`workflows/rust-review.js`): it scout-scales
depth to the diff, fans out the lenses below, grounds findings in tool output, and adversarially
verifies each one. This skill is the rubric the workflow and the `rust-reviewer` lens worker apply.

## When to Use

- Reviewing a diff / PR of Rust code
- Deciding whether changes are safe to commit or merge
- A self-check before opening a PR

## Step 1 — Establish the gate (CI-aware)

The mechanical gate is non-negotiable: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, and (if installed) `cargo audit` / `cargo deny check` must be green before human-style review is worth doing. But **before running a check locally, ask whether CI already computed it on this PR; if a conclusive required check covers it and is green, consume that result instead of recomputing.** Re-running a cold build the PR already ran in CI is slow, sometimes impossible (no toolchain/network), and redundant.

Establish each signal:

1. **Detect the PR's CI** for the current branch:
   ```bash
   gh pr checks --json name,state,bucket,link
   ```
   If `gh` is missing, unauthenticated, offline, or finds no PR → fall straight through to the local gate (never fail on detection).
2. **`fmt` / `clippy` / `test` / `build`** — if a required check whose name matches the command (substring: `fmt`, `clippy`, `test`, `build`/`check`) is conclusive:
   - green → treat that command as **PASSED**; record provenance `via CI · PR #N`;
   - failed → the gate is red: verdict **Block**, cite the failed check name + link, stop;
   - pending / absent / name unrecognized → run that command locally (the safe default is an extra run, never a skipped check):
     ```bash
     cargo fmt --check
     cargo clippy --all-targets -- -D warnings
     cargo test                         # or: cargo nextest run + cargo test --doc
     ```
3. **`audit` / `deny`** — always run locally if installed, regardless of CI (cheap, usually absent from CI):
   ```bash
   cargo audit                        # if cargo-audit present
   cargo deny check                   # if cargo-deny present
   ```
   Setting up / interpreting `cargo audit` + `cargo deny` → `rust-security`.

If any `fmt`/`clippy`/`test`/`build` signal is red (CI or local), stop and report — don't review further. A green gate is the floor, not the ceiling — whatever its provenance, it means the change is *reviewable*, not that it's good.

## Step 2 — Severity checklist

Review the diff against these tiers. This skill owns only the review *process*; cite the owning skill for each fix:

- Safety / injection / secrets / untrusted-input limits → `rust-security`
- `unsafe` / missing `// SAFETY:` → `rust-unsafe`
- Result-vs-panic, typed-error-vs-`anyhow` → `rust-errors`
- `.clone()` / `&str`-vs-`String` / lifetimes → `rust-ownership`
- Blocking-in-async / lock-across-`.await` / deadlock / `Send`+`Sync` → `rust-concurrency`
- Allocation / hot-path / N+1 → `rust-performance`
- Generic code smells / naming / wildcard-match / missing-`///` → `rust-idioms`
- Structural simplification / file decomposition / spaghetti branching → `refactoring`
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
- Crate-root `#![deny(warnings)]` (or other blanket lint-level attributes) — brittle: a new compiler/clippy lint becomes a hard build break for the crate and its dependents → move the denial to CI (`rust-idioms` anti-patterns)

**Maintainability & structural simplification** (fix → `refactoring`, `rust-idioms`)
- **Missed code judo** — a reframing that uses the existing architecture more effectively would make this change *dramatically* simpler or delete a whole category of complexity (a layer, a branch family). Don't flag hypothetical rewrites; flag a concrete, behavior-preserving restructuring the author could have taken.
- **File-size growth** — the diff pushes a file across ~700 lines (Rust files are dense; this is the decomposition smell, the per-function ~50-line rule above is separate) → split by responsibility.
- **Spaghetti branching** — a new ad-hoc conditional / one-off branch / scattered special-case spliced into an unrelated or shared flow, instead of behind a dedicated abstraction (→ `refactoring` "replace conditional with dispatch").
- **Needless optionality / casts** — superfluous `Option` wrapping where the value always exists, `as`-casts where `From`/`TryFrom` belongs, `Box<dyn Any>` / downcasting where a typed model fits.

### Maintainability bar — presumption of block (strict mode)

By default the maintainability items above are **MEDIUM** (warn, may merge). When the review is dispatched in **strict mode** (the `rust-review` workflow's `strict` flag, or an explicit "harsh maintainability review" request), they invert to a **presumption of block**: each is treated as a blocker *unless the author has clearly justified it in the diff or brief*. In strict mode, Approve additionally requires:

- no structural regression (a previously cohesive module didn't become more coupled or harder to scan);
- no obvious simplification missed (the code-judo check above came up empty);
- no unjustified file-size explosion;
- no spaghetti-growth from special-case branching;
- no hacky or magical abstraction obscuring the design.

Strict mode raises the bar; it does not invent findings — every item still goes through the verification protocol and a refuted item is dropped.

### Public-API diffs — the API-design pass

When the diff changes a **public API** (a library crate, a published `pub` surface), also run the
condensed Rust API Guidelines checklist → [api-design.md](api-design.md). It catches the
library-author concerns the general checklist above doesn't — missing common-trait impls,
`Deref`-as-inheritance, out-parameters, unsealed extensible traits, leaking unstable deps, absent
`CHANGELOG`/metadata. Each item points at the craft skill that owns the fix. Skip it for
application-internal code.

## Review lenses

The workflow fans the rubric out into independent lenses, each reviewing ONE slice blind to the
others (higher recall than one broad pass):

| Lens | Slice | Owning skill for the fix |
|---|---|---|
| safety | injection / secrets / unsafe / untrusted-input limits | `rust-security`, `rust-unsafe` |
| errors | Result-vs-panic, dropped errors, typed-vs-anyhow | `rust-errors` |
| ownership | needless clone, `&str`/`&[T]`, lifetimes | `rust-ownership` |
| concurrency | blocking-in-async, lock-across-await, deadlock, Send/Sync | `rust-concurrency` |
| performance | hot-loop allocation, N+1, needless owning | `rust-performance` |
| api-idioms | typed errors, giant fns, wildcard match, missing docs, `#![deny(warnings)]` | `rust-idioms` |
| maintainability | structural simplification (code judo), file-size growth, spaghetti branching, needless optionality/casts | `refactoring`, `rust-idioms` |
| tests | test *quality* not just presence; missing regression/error-path tests | `rust-testing` |
| intent | does the change do what the brief/spec says? | `specs` |

Each lens expands context (callers/impls/error paths via `rust-navigation`) and emits blast-radius
for changed public symbols.

## Confidence tiers — surface, don't censor

- **Confirmed** — located and survived verification; drives the verdict.
- **Suspected** — borderline or unverified; surfaced for the author, **never** changes the verdict.

Report everything you suspect. Borderline findings go to Suspected, not the bin.

## Tool grounding (seed findings)

Beyond the gate, the workflow runs real tools scoped to the diff and feeds their output in as seed
findings (each still verified): `cargo clippy -W clippy::pedantic -W clippy::nursery`; for
published libraries `cargo semver-checks check-release`; and `semgrep` as a SAST seed — in-repo
`./semgrep/` custom rules always when present, plus `p/rust`/`p/secrets` when the diff is
security-sensitive (auth, crypto, input parsing, unsafe, FFI, deps). semgrep results are seeds, never
gate failures: taint/secrets over-report, so the downstream verification refutes the false positives
(see `rust-security`). Optional tools degrade gracefully when absent.

## Verification protocol

Every finding (lens or seed) is checked before it can be Confirmed:

- **Adversarial:** skeptics try to REFUTE it (default to refuted when uncertain). One skeptic by
  default; three-vote consensus for Critical/High.
- **Self-verification (anti-hallucination):** re-read the cited `file:line` — does the code
  actually say what the finding claims, and is the path reachable in production (not test/example)?
  A wrong citation or unreachable path drops or demotes the finding.

## Step 3 — Verdict

| Verdict | When |
|---|---|
| **Approve** ✅ | gate green (CI or local), no **Confirmed** CRITICAL/HIGH/MEDIUM |
| **Warning** ⚠️ | gate green (CI or local), **Confirmed** MEDIUM only — Suspected items listed but don't block |
| **Block** ⛔ | gate red (CI or local), or any **Confirmed** CRITICAL/HIGH |

In **strict mode**, the maintainability bar applies: a Confirmed maintainability finding (code judo missed, file-size explosion, spaghetti branching, hacky abstraction) is a **presumptive Block** unless the author justified it — escalated from its default MEDIUM. Outside strict mode those findings stay MEDIUM (Warning at most).

Report findings as `severity · file:line · what · why · fix`. Be specific and cite the line; a finding without a location isn't actionable.

"Gate green / red" is read from Step 1 — the signal may come from a green required CI check or a local run. Cite which in the `## Gate` line of the output.

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

A green **required CI check** for the same command is also valid proof of that command (see Step 1 — Establish the gate). The point of the table is that *some* fresh authoritative signal exists — CI or local — not that you must re-run it yourself.

State the claim **with** the evidence, or state the real status with the evidence. An earlier run, a "should pass", or a subagent's self-report is not evidence.

## Boundaries

- *How* to write the missing tests → `rust-testing` skill (this rubric only flags that they're missing).
- This skill judges; it does not rewrite. Propose the fix, let the author apply it.
- The generic review/verify *discipline* → `superpowers:requesting-code-review`, `superpowers:receiving-code-review`, `superpowers:verification-before-completion`.
