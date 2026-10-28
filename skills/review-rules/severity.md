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

| Harm named | Highest allowed |
|---|---|
| Data loss or corruption that is not recoverable from a durable source | must-fix |
| Security: a boundary crossed, a secret exposed, an authorisation skipped | must-fix |
| Outage: a service, a controller or a tenant stops serving and does not resume by itself | must-fix |
| An irreversible external effect: money moved, a message sent, an object deleted outside the system | must-fix |
| A wedged or drifted state that an operator must recover by hand | should-fix |
| State that heals by itself on a later pass, a slower or noisier retry cadence | optional |
| Wrong text, a misleading comment or doc, a log line, a name | optional |
| A missing test with no harm named for the behaviour it would pin | optional |
| Maintainability: structure, size, duplication, idiom | optional |

Read the table top down and stop at the first row the finding honestly fills. A finding may sit
below its cap — reachability, an unlikely trigger or a small blast radius lower it — but never
above.

Two refinements:

- **A false comment, doc or name** is rated by the behaviour it causes, not by its text. If the
  next caller will act on the false claim and lose data, the finding is rated as that data loss
  (see sweeps.md §5). If nobody acts on it, it is optional.
- **A missing test** is rated by the defect it would have caught. Name that defect and its harm,
  and the finding takes that row; name none, and it is optional.

## Borderline findings stay in

The cap decides severity, not whether to report. A lens still reports everything it suspects; a
finding with a weak or unknown harm is reported low, with the unknown part said plainly.
Verification and synthesis can raise it when the harm is shown.

## Who enforces it

- **The lens** sets severity from the harm it names, and writes the harm into the finding.
- **The verifier** that finds the harm larger or smaller than claimed says so in its reason.
- **The verdict and synthesis** refuse a severity above the cap: a must-fix with only an operator
  recovery named is reported as should-fix, and the report says it was lowered and why.
- A severity floor (for example, the deletion and recovery path floor of `distributed-races`)
  applies only when the finding names a harm of operator recovery or worse. A floor does not
  invent a harm the finding did not name.

An explicit stricter bar set by the person who asked for the review (a strict maintainability
review, say) overrides the optional cap for the lens it names, and the report says so.
