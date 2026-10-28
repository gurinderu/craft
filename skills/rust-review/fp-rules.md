# Rust review — exclusion catalog (false-positive precedents)

The mirror of [rules.md](rules.md). That catalog names what a finding **is**; this one names the
precedents under which a finding is **dropped** — and, in the second half, the tempting non-reasons
that must never drop one.

This file holds the Rust-specific precedents. The ones that hold in every language (FP-002,
KEEP-002, KEEP-004 and later additions) live in the `review-rules` skill's `fp-rules.md`; their rows
below only point there. Read both: they share one ID space.

A rejection is a claim, and it carries the same burden of proof as the finding it kills: each rule
below demands a specific **trace**, not a pattern match. "Looks guarded" does not fire FP-001; you
fire it by following the invariant to its source and showing it dominates the sink on every path.
Cite the ID in the verdict (`refuted per FP-006`) so the rejection is addressable and reviewable —
a silent drop is not.

IDs are append-only: never renumber or reuse a retired ID.

## Exclusions — citing one drops the finding

| ID | Rule | Required trace |
|---|---|---|
| **FP-001** | **Invariant-protected unchecked read.** An `unsafe` unchecked read (`get_unchecked`, `.add()`, `from_raw_parts`, `read_unaligned`, raw index) whose index/offset/length is provably bounded by an invariant established *before* the read — a preceding mask/exclusion, a parse-time field validation, an enforced buffer size, a caller contract enforced at the trust boundary | Follow the invariant to where it is established and show it **dominates the read on every path**. If the only guard is a `debug_assert!`, FP-001 does **not** apply — that is `SAF-008` |
| **FP-002** | *Language-independent — defined in `review-rules` `fp-rules.md`* (operator-controlled or trusted-by-construction input; a severity downgrade, not a refutation) | See there |
| **FP-003** | **Memory-corruption category in safe Rust.** A UAF / double-free / OOB / data race reported on a path with no `unsafe` block and no FFI — the borrow checker and bounds checks preclude it | Confirm no `unsafe` and no FFI anywhere on the path, not just at the cited line. Panics and DoS in safe Rust are **not** excluded by this rule — they are real availability issues |
| **FP-004** | **Release-stripped assertion with no consequence.** A panic that can only fire in a debug build (a `debug_assert!`, or an overflow panic the shipped `[profile.release]` disables) **and** whose value has no downstream index / allocation / security-decision consequence | Read what the release build does *after* the stripped assert. If that path then indexes or allocates with the un-asserted value, the finding is **real** and the stripped assert **is** the bug (`SAF-007` / `SAF-008`) |
| **FP-005** | **Operator-only panic surface.** A panic (`unwrap`/`expect`/index/overflow) reachable only from CLI arguments, config files, environment variables, `build.rs`, or `#[cfg(test)]`/bench/example code | Trace the panicking value back to its entry point. Only panics reachable from attacker-controlled data through a public or exported API survive. **Severity downgrade, not refutation** — see below |
| **FP-006** | **Proven-`Some`/`Ok` unwrap.** `unwrap()`/`expect()` on a value the same path just constructed or proved present — insert-then-get, `is_some()`-guarded, a literal, a checked length | Show the proof is on the **same path** and nothing between can invalidate it. An unwrap on a fallible operation over untrusted data (parse, decode, checked conversion) is never FP-006 |
| **FP-007** | **Wrong-value-only overflow.** An integer overflow (`wrapping_*`, unchecked arithmetic, `as` truncation) producing only an incorrect value, with no effect on a later index, pointer offset, allocation size, or security decision | Follow the wrapped value to its consumers. If it then indexes memory, sizes an allocation, or gates a decision, it is **real** — that is the OOB/DoS, not a cosmetic wrap |

**FP-005 does not refute**, exactly as FP-002 does not (the rule and its reasoning are in
`review-rules` `fp-rules.md`): the technical claim still holds, only the attacker's access to it is
missing. Record the trust-boundary classification in the verdict reason and leave the finding
standing for severity calibration.

## Not exclusions — the tempting non-reasons

Citing one of these to drop a finding is itself the error. They exist because each is a plausible
sounding dismissal that has repeatedly killed real defects.

| ID | Rule |
|---|---|
| **KEEP-001** | **Soundness and security are different axes; both count.** A safe API with unsound internals — a safe `fn` whose contract safe code can break — is real even if no current caller triggers it: that is precisely the class a later refactor turns exploitable. Conversely a pure logic / authz / protocol bug in fully-safe Rust is also real. FP-003 excludes memory-corruption categories only, never logic bugs |
| **KEEP-002** | *Language-independent — defined in `review-rules` `fp-rules.md`* ("we don't call that path" is not a refutation). In Rust it covers an unsafe-soundness or panic finding on a `pub` API no current caller reaches |
| **KEEP-003** | **Panic-safety is memory safety inside `unsafe`.** A panic that unwinds through a temporarily-broken invariant in an `unsafe` region — via a callback, a `Drop`, or an allocation — and yields UB, UAF or double-free is a memory-safety finding, not "just a panic". Do not apply the availability-only lens (FP-005) to it. Fix guidance → `rust-unsafe` |
| **KEEP-004** | *Language-independent — defined in `review-rules` `fp-rules.md`* (an unverifiable premise is not a refutation — see `SKILL.md` → *Premise grounding*) |

## Adding a rule

Append under the right section with the next free number across this file **and** the
`review-rules` `fp-rules.md`; never renumber. A rule that holds in every language goes there. An exclusion must state
the **trace that fires it**, not just the shape it matches — a rule a reviewer can apply by pattern
alone will drop real findings.
