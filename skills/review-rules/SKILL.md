---
name: review-rules
description: >-
  Language-independent code-review rules, read alongside a language rubric (rust-review, nix-review) by every review lens and verifier — severity capped by the harm a finding names (who is hurt, how they recover; must-fix only for data loss, security, outage or an irreversible effect), the finding classes (CONV, LIFE, RECOV, EXT, WIRE, RACE, FAIL, TEST, DOCS, MAINT) and how to pick one, the search sweeps a lens runs (sibling sweep over every place of a class, early-exit diff, attribution check, context before judgment, consequence of a false claim), and the exclusions that drop a finding in any language. Use when reviewing a diff in any language, rating a finding's severity, or deciding whether a rejection holds. Triggers: how severe is this, is this must-fix, harm, finding class, same class elsewhere, sibling instance, early return skips, false positive. Not for a language's own rules (rust-review, nix-review), controller races (distributed-races) or backward compatibility (compatibility).
---

# Review rules — what holds in every language

A language rubric says what a defect looks like in that language. These files say what holds
whatever the language: how bad a finding is, what kind it is, where to look for its siblings, and
when it may be dropped. A review lens reads them together with its language's rubric; when the two
disagree on severity, the harm cap here wins.

## Files

| File | What it settles |
|---|---|
| [severity.md](severity.md) | Severity from the harm a finding names: effect, who is affected, recovery. The cap each kind of harm allows, and the rule that a verdict refuses a severity above it. |
| [classes.md](classes.md) | The finding classes CONV, LIFE, RECOV, EXT, WIRE, RACE, FAIL, TEST, DOCS, MAINT, and the rule for choosing one: the class whose fix removes the defect. |
| [sweeps.md](sweeps.md) | Five search moves a lens runs before it stops: sibling sweep, early-exit diff, attribution check, context before judgment, consequence of a false claim. |
| [fp-rules.md](fp-rules.md) | Exclusions that drop a finding in any language, and the tempting non-reasons that never do. The language rubric's own exclusion file carries the rest under the same ID space. |

## Order of work

1. Read the change with **sweeps.md** §4 first: call sites, helpers, readers of written fields.
2. For each defect, name its **class** (classes.md) and its **harm** (severity.md).
3. Run the **sibling sweep** (sweeps.md §1) for every class you found, and the **early-exit diff**
   (§2) for every early return the change touches.
4. Rate by the harm cap. A finding with no nameable harm is optional or Low, not dropped.
5. Before dropping anything, check **fp-rules.md**: a rejection carries the same burden of proof as
   the finding.

## Relation to other skills

Catalogues of specific question sets stay in their own skills and are read beside these rules:
controller and reconcile-loop races in `distributed-races`, backward compatibility in
`compatibility`. Their classes map onto the classes here (an R-class is mostly RACE, CONV or
RECOV; a C-class is WIRE). Each language rubric keeps only what is specific to its language and
points here for the rest.
