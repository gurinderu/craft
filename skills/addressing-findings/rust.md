# Rust wiring

The Rust-specific half of the fix loop: who to re-dispatch, where each fix lives, and what proves
a fix landed.

## Fix → owning skill (step 5)

This skill flags *that* something needs fixing; the owning topic skill says *how*. The routing
mirrors the `rust-review` severity checklist:

| Finding area | Owning skill |
|---|---|
| safety / injection / secrets / untrusted input | `rust-security` |
| `unsafe` / missing `// SAFETY:` | `rust-unsafe` |
| Result-vs-panic, typed-error-vs-`anyhow` | `rust-errors` |
| `.clone()` / `&str`-vs-`String` / lifetimes | `rust-ownership` |
| blocking-in-async / lock-across-`.await` / deadlock / `Send`+`Sync` | `rust-concurrency` |
| allocation / hot-path / N+1 | `rust-performance` |
| code smell / naming / wildcard match / missing `///` | `rust-idioms` |
| missing tests | `rust-testing` |

A **bug fix** starts by finding the root cause before touching code (→
`superpowers:systematic-debugging`; the Rust toolbox → `debugging`), then a regression test:
write it, watch it fail (RED), fix, watch it pass (GREEN). The TDD mechanic →
`superpowers:test-driven-development`; the Rust test tooling → `rust-testing`. (Cite them —
don't restate.)

## Verify (step 6)

Prove each fix with the matching command from the `rust-review` "Proving a claim — what proves
what" table — do not re-derive it here, cite it: `rust-review` SKILL.md, the "Proving a claim"
section. The discipline (no "done" without a fresh run you read this session) →
`superpowers:verification-before-completion`.

## Re-review (step 7)

Re-dispatch the craft review agents on the post-fix diff (a **fresh** agent each time — they carry
no memory of the prior round):

- `craft:rust-reviewer` — the gate + the rubric.
- `craft:rust-security-scanner` — when the change touched deps / `unsafe` / input handling.
- `craft:rust-miri` — when the change touched `unsafe`.
- or re-run the `rust-audit` workflow for all of them at once.

Feed the new findings back into the loop. The triage ledger (keyed by `stable_id`) dedups
recurring findings from genuinely new ones, so "loop until green" terminates on progress, not
churn.
