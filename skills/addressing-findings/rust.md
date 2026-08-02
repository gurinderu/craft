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

A **bug fix** starts by finding the root cause (the Rust toolbox → `debugging`), then a
regression test: write it, watch it fail (RED), fix, watch it pass (GREEN). The Rust test
tooling → `rust-testing`.

## Verify (step 6)

Prove each fix with the matching command from the `rust-review` "Proving a claim — what proves
what" table — do not re-derive it here, cite it (`rust-review` SKILL.md, the "Proving a claim —
what proves what" section). The three completeness checks are in `SKILL.md` → *When a fix is done*;
their Rust mechanics:

- **Every facet.** A profile-divergent bug (`SAF-007`) has two: re-run the case under `cargo test`
  (dev, `overflow-checks` on) **and** under the shipping profile (`cargo test --release`, or a
  release-profile repro binary). Fixing only the panic leaves the silent-wrap facet alive.
- **Your own check, not the fixer's.** Point a scratch crate at the fix branch as a path dependency
  — `[dependencies] thing = { path = "../thing" }` — and drive it through the real public entry
  point rather than running the fixer's own test module. Then `cargo test` the whole suite yourself.
- **Sibling sweep.** `rg` the pattern across the crate before closing: the sibling method that pops
  the same stack, the second call site of the same helper, the `impl` block that repeats the guard.
  `cargo mutants` scoped to the changed files also surfaces contracts no test would catch.

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
