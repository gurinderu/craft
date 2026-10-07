---
name: addressing-findings
description: >-
  Systematic fix loop for review findings — gather them from craft review agents, rust-audit reports, and GitHub PR comments, record the author's PR-thread rejections of craft findings as project decisions and deferred findings as open questions, offer (and record only on the author's yes) a lesson for each finding that recurs across branches, triage each against the code, order, fix, verify, and re-review (handing the recalled decisions to the review) until green. Use after a review or audit produces findings, working through PR comments, or deciding what to fix first. Triggers: address review comments, fix the findings, triage findings, what to fix first.
---

# Addressing Findings

The fix counterpart to `rust-review`: take a set of review findings and work them to green —
gather, normalize, triage, order, fix, verify, re-review, close the loop. This skill owns the
concrete, Rust-aware process and points at the topic skills for *how* to fix each thing.

## When to use

- After a review / `rust-audit` produces findings, or you're working through PR comments.
- Deciding what to fix first and proving each fix landed.
- **Not** for *doing* the review (→ `rust-review`) or *running* the agents (→ `rust-audit`).

## The fix loop

`⫲` marks a step that **fans out across subagents** (→ "Parallelism via subagents").

```
0. Recall    — the author's PR-thread rejections recorded first (→ pr-rejections.md),
               then `memory` recall(topic, scope) for every path the findings touch (→ below),
               then findings that recur across branches shown, a lesson offered per group (→ below)
1. Gather  ⫲ — collect findings from both sources, one subagent per source in parallel:
               • craft: a rust-reviewer verdict / a rust-audit report
               • GitHub: gh pr view / gh api → inline thread comments     (→ github.md)
2. Normalize — to the unified schema; tag source; compute stable_id        (→ schema.md)
3. Triage  ⫲ — per finding, validated against a pinned ref, one subagent per finding:
               accept / reject / defer / needs-decision / conflict (+ reasoning)
4. Order     — accepted only: blocking → simple → complex; group by file to cut churn
               (the grouping is what makes step 5 parallelisable — independent groups)
5. Fix     ⫲ — list every place the violated property lives, then patch them  (→ below)
               independent file-groups fixed concurrently, one subagent per group
               (worktree isolation when groups could touch shared files). Within a
               group, serial. "How to fix" → topic skills; a bug → regression test
               first, RED→GREEN                                                (→ rust.md)
6. Verify    — per fix: every facet · your own check · sibling sweep ·
               falsify per element · bounds reached                           (→ below, rust.md)
7. Re-review ⫲ — PR-thread rejections recorded again, active decisions and questions recalled and passed
               to the review workflow as `priorDecisions`, an object argument (→ `memory`, "Before a review");
               re-dispatch the review agents in parallel (as rust-audit does); new
               findings re-enter the loop; the ledger dedups; repeat until green (→ rust.md)
8. Close loop— (GitHub) draft replies (what was fixed / why rejected + commit), post &
               resolve ONLY after explicit user OK; map reply→thread via thread_id (→ github.md)
```

**Scaling:** small batch → steps 2–4 inline. Large batch (a fat `rust-audit` report, a
many-comment PR) → dispatch the `craft:triage-findings` workflow, apply its plan, then run the
re-review loop.

## Triage outcomes

Validate each finding against the code (pinned to the ref it was generated against), then:

| Verdict | Meaning | Where it goes |
|---|---|---|
| `accept` | real, in scope | into the plan |
| `reject` | wrong / not a real problem | ledger + drafted pushback |
| `defer` | valid but out of scope now | ledger (stays deferred across runs) + an open question in `memory` |
| `needs-decision` | valid but needs a product/spec call, **or** has no resolvable location | → `specs` |
| `conflict` | contradicts another finding | both surfaced for a human; never silently pick one |

**Locationless findings** (file- or PR-level comments) get an explicit lane: resolve a concrete
location during triage, else route to `needs-decision` — never drop them silently.

`reject` → `rejected` and `defer` → `deferred` are also written back to the **review ledger** so
the next re-review carries them forward (→ "Writing dispositions to the review ledger").

## Project memory — recall before, record after

The review ledger is per branch and machine-local; the *reason* a finding was dismissed is a fact
about the project that should outlive the branch. The `memory` skill keeps it (whatever backend
the project has; it prints `memory backend: …` once).

- **Before triage (step 0)** — `recall(<finding keywords>, <path>)` for every touched path. A
  matching **active** decision is known context: a finding it already answers is triaged with that
  reason cited (and its id), not re-litigated — unless the code the decision relied on has changed,
  in which case say so and supersede the decision instead of applying it. A matching **active
  question** on the finding's title means it was deferred before: cite it, and either keep it
  deferred or answer it (a decision that supersedes it).
- **On a disposition** — `record-decision` with title = the finding's title, scope = its file path
  (the component, or `.`, for a locationless finding), body = the reason, author = who decided
  (the user, or the PR author whose reply it was), commit = `git rev-parse HEAD` at triage, links =
  PR / thread / commit. Triggered by triage `reject` and a finding kept but `justified` in the PR
  body.
- **A deferral is an open question, not a decision** — triage `defer` becomes `record-question`
  with title = the finding's title, scope = its file path, body = what would answer it (the event,
  the change or the call that would settle it), author = who deferred, commit = `git rev-parse
  HEAD` at triage, links = the PR and the comment URL. The next review lists that finding under
  **Known and deferred** instead of raising it as new — until it turns Critical/High or its file
  changes. A deferral recorded earlier as a decision stays a decision; when a question is answered,
  the decision supersedes it.
- A `needs-decision` becomes `record-question` too (body = what decision is needed, from whom);
  when it is decided, the decision supersedes the question.
- **Recurring findings — a lesson only on the author's yes (step 0, after recall).** A finding that
  keeps coming back on different branches is a pattern, not a one-off. Read craft's run store for
  the touched paths:

  ```bash
  node "<this skill's base directory>/../../lib/recurring-findings.mjs" --path <path> [--path <path> …]
  ```

  It prints one JSON object: `groups` of `{file, titles, branches, runs, severities, lastSeen}` —
  the same finding (same file, overlapping title) in the review ledgers of at least two different
  branches of this project; the same branch reviewed twice is not a recurrence, another project's
  runs never count. `--store <dir>` reads another store (default `~/.craft/runs`), `--project
  <dir>` another checkout. Its `note` names every bound it reached (the newest 500 runs read, 20
  groups listed) — repeat that line, never present a cut list as whole.
  Show each group (file, titles, branches, when last seen) and **ask the author, per group**,
  whether to record a lesson. Yes → `record-lesson` with scope = the file, title = the pattern in one
  line, body = the pattern and what avoids it (in the author's words), links = the runs or PRs.
  No answer or no → write nothing. No run store, or no group → say so in one line
  (`recurring findings: none — <the note>`) and continue.
- **Subagents** (triage, fix) lack the memory tools: the launcher recalls and puts the matching
  records, verbatim with ids, into each brief; their reject/defer verdicts come back in the result
  and the launcher records them. Known limit, not a gap to route around.

## Fix the property, not the example (step 5)

A finding names one instance; the defect is the property that instance violates. Before patching,
find every place that property lives **by code structure** — the shape of the call, the field, the
guard — not by the name in the finding: a name match misses the wrapper under another name and
breaks on the next rename. Write the list down, then patch every entry. Fixing only the named place
lets the same property fail next door, in the spot the reviewer did not point at.

## When a fix is done (step 6)

The proof table in `rust-review` says how to prove *a* claim. These checks say when the fix
itself is finished. Each exists because a fix that passed the obvious check still shipped broken.

**Every facet, not the loudest one.** A bug with more than one observable effect — a panic *and*
silent corruption, two build profiles, two entry points, two callers — is not fixed until the case
for **each** is re-run green. A plausible, idiomatic, symmetric one-liner can silence the symptom
that fired first and leave the other alive: saturating arithmetic removes the panic while every
saturated value still collapses to the same bucket downstream, so the misresolution it caused
persists. Enumerate the facets from the finding before you accept the fix, and re-run all of them.

**Your own check, not the fixer's.** When a subagent or another author reports "fixed, tests pass",
that is a claim, not evidence — its test can construct the broken state differently from the real
entry point, or assert something subtly weaker than the contract. Verify against the fix as an
outsider would: exercise it through the real entry point, and re-run the full suite yourself. A
green suite written by whoever wrote the fix proves the two agree, not that the bug is gone.

**Sibling sweep.** Bugs travel in packs. Before closing, grep for the same pattern elsewhere — the
adjacent method, the other call site, the mirror path (`rust-review` → *The mirror walk*). A fix
can close the one reported instance and leave an identical sibling untouched, invisible to the one
case that was tested. Findings in the same file/pattern group can be swept together in one pass.

**Falsify per element.** A green test after the fix proves the tests agree with the fix, not that
they guard it. A fix touching N places is proven by breaking each place separately and seeing N
red tests, each naming the place it broke. One break per loop proves one element, not the loop. A
falsifier that stays green is not yet evidence the test is strong — it may be a weak falsifier
(the break still lands on the guarded side, or is caught for an unrelated reason); say which.

**Bounds the fix introduces.** Coverage built from past bugs cannot see limits the fix itself
adds — a limit, timeout, size, depth, retry count. For each one, write a case where it is reached,
built by the failure mechanism (a route that exits and comes back, not one that stays inside).
On exhaustion the code must refuse, not continue on the unfinished state: a bound that fails open
is not a bound.

Fixed-and-verified findings become `closed` in the review ledger (above); a sibling found during
the sweep is a **new** finding — give it its own stable id rather than folding it into the one
being closed, or the ledger will report a defect as resolved while an instance of it still ships.

## Stable id & the triage ledger

Every finding gets a **stable id** = `source::location::title` (a composite key — deterministic,
readable). A **triage ledger** records the verdict + reason for each finding keyed by stable id.
This one mechanism gives: **idempotent re-runs** (already-`reject`/`defer`/`needs-decision`
findings aren't re-litigated), **re-review identity** (tell "same finding" from "new" so "loop
until green" measures progress, not churn), and **deferred tracking** (deferred findings stay
visible). Schema details → [schema.md](schema.md).

## Writing dispositions to the review ledger

Distinct from the triage ledger above: the **review ledger** is the `craft:review` workflow's per-run
record — `~/.craft/runs/<ts>-workflow-review.json`, keyed by `project + branch`, holding a `ledger`
array keyed by each finding's `fp`. The triage ledger (above) is *your* artifact keyed by
`stable_id`; the review ledger is the *engine's* artifact keyed by `fp` — do not conflate them.
The engine writes `disposition: 'open'` for everything it surfaces; the **human-sourced**
dispositions can only come from this fix loop. Record contract → [schema.md](schema.md).

After **Triage (step 3)** and again after **Verify (step 6)**, write dispositions back:

1. Find the newest `~/.craft/runs/<ts>-workflow-review.json` whose top-level `branch` matches the
   current branch. If none exists, skip — this is best-effort bookkeeping, never a fix-loop failure.
2. For each fix-loop finding, set its `disposition` in that record's `ledger` array
   (vocabulary `open | closed | rejected | justified | deferred`):
   - triage `reject` → `rejected`
   - triage `defer` → `deferred`
   - a fix that landed **and** was verified → `closed`
   - a finding kept (not fixed) but explicitly justified in the PR body → `justified`
   - triage `accept` (not yet fixed), `needs-decision`, `conflict` → leave `open`
3. **Match** a fix-loop finding to a review-ledger entry by `fp` when the finding carries one;
   otherwise by `file` + `ruleId` + a title match. If no entry matches, skip that finding silently.
4. **Why:** this is exactly what lets the next round-aware re-review's *adjudicate track* **carry**
   dismissed (`rejected` / `justified`) findings forward instead of re-raising them, and treat
   `closed` ones as resolved (→ Re-review, step 7; the round-aware `craft:review` workflow).

## Parallelism via subagents

Where craft's fix loop fans out across subagents:

- **Gather (1)** — independent sources → one subagent per source.
- **Triage (3)** — each finding judged independently → one subagent per finding (the core
  fan-out); each brief carries the recalled records for that finding's path (step 0). The dedup/conflict/order step afterwards needs all results together, so it does
  **not** parallelise.
- **Fix (5)** — the plan is grouped by file so **independent groups run concurrently**, one
  subagent per group; worktree isolation only when groups could touch shared files. Within a
  group, serial.
- **Re-review (7)** — review agents run in parallel, as `rust-audit` orchestrates them.

## Rust wiring

Which agents to re-dispatch, the fix-to-skill routing, and the "what proves what" proof table →
[rust.md](rust.md).

## The author's rejections on the PR

Before the loop works the findings, what was already rejected on the PR — a reply that opens with
"not a bug" / "by design" / "won't fix" … — is recorded as decisions with the author, the comment
URL and the commit. Conservative: only a thread whose first comment is a craft finding, whose last
word is that explicit reply, from the PR author or an owner, member or collaborator of the
repository; a thread resolved without a reply is never a rejection. The rule, the `gh` query and
the script → [pr-rejections.md](pr-rejections.md).

## Closing the loop on GitHub

Reading PR threads, and drafting/posting/resolving replies (only after explicit user OK) →
[github.md](github.md).

## Boundaries

- *How* to fix a specific problem → topic skills (`rust-errors`, `rust-ownership`,
  `rust-concurrency`, `rust-security`, …).
- *How* to write the missing test → `rust-testing`.
- Findings needing product/spec input → `specs`.
- This skill does **not** rewrite for the reviewer and does **not** duplicate the `rust-review`
  rubric or its proof table — it cites them.
