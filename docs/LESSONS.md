# craft — lessons

Operational lessons about building and running craft that are **not derivable from the code**: why
a rule is shaped the way it is, what an adopted practice cost, what a change broke. Not a changelog
(`CHANGELOG.md`), not a plan (`docs/superpowers/plans/`), not architecture (`MAP.md`).

**Structure.** The **principles** are the working set — what belongs in your head. Each folds one or
more numbered entries in the **evidence appendix**, where the L-numbers are **stable**: never
renumber, never reuse a retired one, so commits and notes can cite `L2` and still mean it. When a
principle and its evidence seem to disagree, the evidence is the record of what happened; the
principle is the compression.

Add an entry when something was **learned at a cost** — a practice that didn't transfer, a design
that had to be reworked, a failure mode that surfaced in use. Routine work does not qualify.

---

## Principles

### P1 — Adopt the reasoning, not the artifact: check that the failure mode's preconditions exist here — folds L1, L2

Practices imported from another harness or repo arrive shaped by *its* architecture. The lesson
underneath is usually sound; the mechanism on top often solves a problem craft does not have, or
collides with a distinction craft already draws. Before adopting, ask what specific conditions
produced the original failure and whether those conditions hold here — then re-derive the mechanism
in craft's own idiom instead of transplanting it.

- **Do:** name the precondition, check it against craft's actual agent shapes and verdict model, and
  re-express the rule in craft's vocabulary. A rule that has to be explained by reference to the
  source repo has not been adopted, only copied.

---

## Evidence appendix

### L1 — A borrowed safety rule can be inert because craft's agents have a different shape · 2026-08-01

While mining `scadastrangelove/rust-in-peace` for review practices, one candidate was a prohibition
on agents repairing shared toolchain state. Its origin: six parallel **fix**-agents, each with full
Bash and a mandate to make the build pass, sharing one `$HOME`; one decided on its own initiative to
repair `rustup`, caught a network reset mid-download, and left `~/.rustup` half-uninstalled — killing
`cargo` for every other concurrent agent and the orchestrator. Git worktrees isolate sources, not
toolchains.

It was queued for adoption and dropped on inspection. craft's fanned-out agents are **read-only**
reviewers and scanners — `triage-findings` explicitly makes no edits — and every one already carries
"tool absent → note it and continue, never fail" (`agents/rust-security-scanner.md`,
`agents/rust-miri.md`, the build-matrix prompt in `workflows/rust-audit.js`). An agent told not to
fail has no motive to repair anything: the pressure that produced the incident is absent. The rule
would have added prohibition text that never fires.

- **Change:** none — deliberately. Revisit if the `addressing-findings` fix loop ever fans out into
  parallel *editing* agents; that is the shape the rule guards, and then it earns its place.

### L2 — An imported rule set has to be re-routed through craft's own verdict model · 2026-08-01

Adopting the same repo's false-positive catalog as `skills/rust-review/fp-rules.md` looked like a
straight port: seven exclusion precedents, each demanding a trace. Two did not fit. The source
treats "the input is operator-controlled" and "the panic is only reachable from CLI/config" as
FALSE_POSITIVE verdicts, because its pipeline ranks live vulnerabilities and latent hardening on one
axis. craft's verifier separates them: `refuted` means *the technical claim is false*, and its
refutation rule already states that context — test-only, low impact, intentional — never justifies
it. Importing those two as written would have contradicted that rule and taught verifiers to delete
findings whose claims hold.

They ship as **severity downgrades with `refuted=false`** instead. The same round produced a second
instance: an unsupported premise also had to be routed to Suspected rather than refuted, because
`adversarial-review` feeds its refuted list forward as "adversarially disproven — do not re-report",
so a missing citation would have buried a possibly real defect for the rest of the run.

- **Change:** when importing a rubric, map every verdict it produces onto craft's existing verdict
  vocabulary **before** writing it down, and check what each downstream stage does with that verdict.
  A bucket name that matches is not a meaning that matches.
