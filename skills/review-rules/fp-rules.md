# Review rules — exclusions that hold in every language

The language-independent part of the exclusion catalogue. A language rubric's own exclusion file
(for Rust, `rust-review`'s `fp-rules.md`) carries the language-specific precedents. **Both files
share one ID space**: an ID is defined in exactly one of them, never reused, never renumbered.

A rejection is a claim, and it carries the same burden of proof as the finding it kills: each rule
below demands a specific **trace**, not a pattern match. Cite the ID in the verdict (`downgraded per
FP-002`) so the rejection is addressable and reviewable — a silent drop is not.

## Exclusions — citing one drops or downgrades the finding

| ID | Rule | Required trace |
|---|---|---|
| **FP-002** | **Operator-controlled or trusted-by-construction input.** The trigger requires input that in this deployment is operator-supplied or trusted by construction — a CI-produced artifact, an operator-signed blob, an internal-only table, a value already validated at an outer boundary — and is not reachable from attacker-controlled data | Name the input that carries the finding and classify it attacker- vs operator-controlled. Multi-tenant, user-uploaded or network-sourced input makes it plausible → FP-002 does **not** apply. **This is a severity downgrade, not a refutation** — see below |

**FP-002 does not refute.** The technical claim still holds; only the attacker's access to it is
missing. Do not mark such a finding refuted — record the trust-boundary classification in the
verdict reason so severity calibration downgrades it to latent hardening. A finding killed as
"operator-only" on an input that turns out to be network-reachable is the expensive mistake here,
and it is invisible once the finding is gone.

## Not exclusions — the tempting non-reasons

Citing one of these to drop a finding is itself the error.

| ID | Rule |
|---|---|
| **KEEP-002** | **"We don't call that path" is not a refutation.** A finding on a **public or exported** API survives the fact that the current code does not reach it — downgrade its reachability and severity, keep the finding. Distinct from FP-002 (operator-only *input*) and from an invariant that actually dominates the sink *today* |
| **KEEP-004** | **An unverifiable premise is not a refutation.** Being unable to confirm a claim is not the same as disproving it. Such a finding is Suspected, not refuted |
| **KEEP-005** | **"Another lens or round already reported this class" is not a refutation.** The same class at a different place is a different finding (sweeps.md §1). Only the same defect at the same place is a duplicate |
| **KEEP-006** | **A low severity is not a refutation.** A finding whose harm is small is rated low under the harm cap (severity.md), not dropped. Refute only a technical claim that is false |

## Adding a rule

Take the next free number across **both** this file and the language rubric's exclusion file;
never renumber. Put a rule here only when it holds in every language; a rule that names a
language's construct belongs in that language's file. An exclusion must state the **trace that
fires it**, not just the shape it matches — a rule a reviewer can apply by pattern alone will drop
real findings.
