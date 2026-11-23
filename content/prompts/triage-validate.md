Judge ONE review finding against the actual code. {{pin}}

Finding (source: {{source}}):
- severity: {{severity}}
- location: {{location}}
- what: {{title}}
- why: {{detail}}
{{proposedFixLine}}
{{memoryNoteLine}}

Read the cited code, then decide ONE verdict:
- accept — a real, in-scope problem. fix_pointer = owning craft skill (rust-errors/rust-ownership/rust-concurrency/rust-security/rust-performance/rust-idioms/rust-testing/rust-unsafe) + a one-line fix direction.
- reject — not a real problem / wrong; explain why (this becomes reviewer pushback).
- defer — real but out of scope now; say why.
- needs-decision — valid but needs a product/spec decision, OR the finding has no resolvable location; say what is needed.

PREMISE DISCIPLINE: name the ONE claim your verdict rests on. If it lives outside the cited location — the dependency behaves this way, this is reachable from untrusted input, a caller already guards it, the sibling path does X — OPEN that code (dependency sources included) and record the file:line in premise_checked. This binds **reject** exactly as much as accept: "a caller must already validate this" waved through without opening the caller is the same unfounded claim as the finding it dismisses, and it silently discards a real bug. If you cannot open it, do not guess — verdict needs-decision, saying which premise is unverified. {{dependencySourceHow}}

NOISE CLASSES (noise_class; 0 when none applies — a defect of this change). They are judged on the code, never on the source's own label:
1 — not this change's: the problem already stands at the PR's base (the diff did not bring it) or lies outside the change's task. Check it AT THE BASE, not by the reviewer's word ("pre-existing", "out of scope"): {{classOneBase}}. Verdict defer when the problem is real — the triage carries it to an issue; reject when it is not (no issue is filed).
2 — inflated severity: the claimed harm is unreachable or heals itself (a default requeue, only a metric). Judge the verdict on the merits and lower severity to what the code supports.
3 — a repeat of a finding already decided — reject, naming it.
4 — a deliberate trade-off written in the project's docs or rules — reject, naming where it is written.
5 — not decidable from the code (a rollout step, a version you cannot verify) — needs-decision, not a fix.
6 — an optional nicety in tests or comments — accept only when worth doing; it is planned apart from the defects.
severity: the source's severity unless the code supports another.

stable_id MUST be exactly: {{stableId}}
Keep reason to one line. fix_pointer empty unless verdict is accept.
