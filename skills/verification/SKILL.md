---
name: verification
description: Verify before claiming done — run the command that proves a claim and read its output before saying anything passes, builds, is fixed, or is complete. Use before reporting success, committing, opening a PR, or trusting an agent's "done". Triggers: done, complete, fixed, passing, it works, ready to commit, ready to merge, verify, confirm, should work.
---

# Verification

Claiming something works without checking isn't efficiency — it's a false report. The rule:
**evidence before assertions, always.** This is the discipline behind the user's own standard
("report outcomes faithfully; when verified, say so plainly; otherwise don't").

## The iron law

```
NO "DONE / PASSES / FIXED / WORKS" WITHOUT FRESH EVIDENCE FROM THIS SESSION
```

If you didn't run the proving command *just now* and read its output, you can't make the claim.
A prior run, "should pass", or an agent's self-report is not evidence.

## The gate

Before any success claim:

```
1. IDENTIFY  — which command proves this exact claim?
2. RUN       — execute it fresh and in full (not a subset, not from memory)
3. READ      — full output: exit code, failure count, the actual numbers
4. JUDGE     — does the output actually confirm the claim?
                 yes → state the claim WITH the evidence
                 no  → state the real status with the evidence
```

Skipping a step is asserting, not verifying.

## What proves what

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

## Red flags — stop and verify

- The words "should", "probably", "seems to", "I think it" before a status.
- Celebrating ("Done!", "Perfect!", "All green!") before running the command.
- About to commit / push / open a PR without a fresh run.
- Trusting a subagent's "completed" without reading its diff (→ `rust-security-scanner`,
  `rust-reviewer` return verdicts you still confirm).
- "Just this once" / "I'm confident" / "I'm tired" — none are evidence.

## Honest reporting

Verification is also about *negative* results: if tests fail, say so with the output; if a step
was skipped, say it was skipped; if you're unsure, say unsure. State done **and verified** only
when the command's output says so — no hedging, no inflation. Confidence is not evidence.

## Boundaries

- The proving commands for testing/coverage → `rust-testing`; for security → `rust-security`;
  the review verdict you still confirm → `rust-review`.
- This skill is *general*: identify the command, run it, read it, then claim — in any language.
