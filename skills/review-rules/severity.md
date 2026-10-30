# Severity — capped by the harm a finding names

Severity is not a measure of how wrong the code looks. It is a measure of what happens to someone
because of it. A finding earns its severity only through a harm it names; without one, it is a
remark, however true.

## Every finding names its harm

Three parts, each in a sentence:

- **Effect** — what goes wrong in the running system: a record lost, a request refused, a resource
  stranded, a secret readable, a status that lies.
- **Who is affected** — the end user, the tenant, the operator on call, the next developer, a
  downstream service, nobody until a later change.
- **Recovery** — how the state gets back to correct: by itself on the next pass, by a retry, by an
  operator's hand (a manual delete, a restart, a script), or not at all.

A finding that cannot fill all three has not been understood yet. Say which part is unknown rather
than filling it with the worst case.

## The cap

The review's levels are must-fix (Critical, High: blocks the merge), should-fix (Medium: warns)
and optional (Low, Info: reported, never blocks).

| `harmLevel` | Harm named | Highest allowed |
|---|---|---|
| `data-loss` | Data loss or corruption that is not recoverable from a durable source | must-fix |
| `security` | Security: a boundary crossed, a secret exposed, an authorisation skipped | must-fix |
| `outage` | Outage: a service, a controller or a tenant stops serving and does not resume by itself | must-fix |
| `irreversible` | An irreversible external effect: money moved, a message sent, an object deleted outside the system | must-fix |
| `intent-unmet` | The change does not achieve its stated purpose: what the PR, the commit or the intent says it is for does not happen, even if the system keeps working as it did before the change | must-fix |
| `repo-rule` | A rule written in the reviewed repository's own files is broken (AGENTS.md, CLAUDE.md, CONTRIBUTING, a documented project convention the lens read), the rule cited | must-fix |
| `operator-recovery` | A wedged or drifted state that an operator must recover by hand | should-fix |
| `self-healing` | State that heals by itself on a later pass, a slower or noisier retry cadence | optional |
| `text` | Wrong text, a misleading comment or doc, a log line, a name | optional |
| `none` | No harm named: a missing test whose defect is not named, maintainability (structure, size, duplication, idiom), a remark | optional |

Read the table top down and stop at the first row the finding honestly fills, and put its
`harmLevel` on the finding. A finding may sit
below its cap — reachability, an unlikely trigger or a small blast radius lower it — but never
above.

Telling the two new rows apart from the rows below them:

- **`intent-unmet`, not `self-healing`**: the question is whether the change does what it is for,
  not whether the system recovers. A feature the change was meant to deliver faster, which instead
  arrives only on the periodic pass that delivered it before the change, heals by itself and is
  still `intent-unmet`: the change's headline mechanism never works.
- **`repo-rule`, not `none`**: a maintainability remark (structure, idiom, an untyped error) is
  `none` unless a rule written in the repository demands it. The finding then quotes the rule and
  names its file in `repoRule` (`{file, text}`); a `repo-rule` finding without that citation is
  read as `none` by the engine, so the harm stays named and a verifier can open the file and check.

Two refinements:

- **A false comment, doc or name** is rated by the behaviour it causes, not by its text. If the
  next caller will act on the false claim and lose data, the finding is rated as that data loss
  (see sweeps.md §5). If nobody acts on it, it is optional.
- **A missing test** is rated by the defect it would have caught. Name that defect and its harm,
  and the finding takes that row; name none, and it is optional.

## Borderline findings stay in

The cap decides severity, not whether to report. A lens still reports everything it suspects; a
finding with a weak or unknown harm is reported low, with the unknown part said plainly.
Verification raises it when the verifier confirms a must-fix harm; synthesis never raises it.

## Who enforces it

- **The lens** sets severity from the harm it names, and writes the harm into the finding.
- **The verifier** is shown the harm a finding claims (for a merged finding, every distinct harm its
  lenses claimed, worst first) and says whether the code shows it (`harmSupported`) and which claim
  held (`confirmedHarmLevel`). A finding a panel confirmed with a must-fix harm verified is raised
  to High; one lowered because the path is unreachable or test-only is never raised.
- **The engine** lowers a finding whose `harmLevel` allows less than its severity to that level's
  ceiling, once, after verification and before anything counts it — so the verdict, the report and
  the run record all see the capped severity: a must-fix with only an operator recovery named
  counts and is reported as should-fix, and its reason says it was lowered and why. A finding with
  no `harmLevel` is left as it is (a lint seed that names no harm reads as `none`, and so does a
  `repo-rule` finding citing no rule). The run record counts how many the cap lowered.
- **Agreement** buys verification, not severity: a finding two or more different lenses reported
  independently, merged into one before verification, is verified whatever its severity when a harm
  it claims is must-fix. Only the verified harm can raise it.
- **Synthesis** never reports a finding above that cap.
- A severity floor (for example, the deletion and recovery path floor of `distributed-races`)
  applies only when the finding names a harm of operator recovery or worse. A floor does not
  invent a harm the finding did not name.

An explicit stricter bar set by the person who asked for the review (a strict maintainability
review, say) overrides the optional cap for the lens it names, and the report says so: in strict
mode the engine does not cap maintainability findings.
