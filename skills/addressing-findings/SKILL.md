---
name: addressing-findings
description: >-
  Fix loop for review findings — gather them from craft reviews, rust-audit reports and PR comments of any reviewer; triage always through the triage-findings workflow launched by the main session, never a subagent (it sifts out what project memory settled, files a finding the PR did not introduce as an issue); write each rejection or justification (PR-thread rejections included) as a decision (a project-wide stance, on the human's word, as a project rule) and each deferral as an open question at once, without asking; let the human post or record each doubtful finding a review held back; offer a lesson per finding recurring across branches; subagents only fix the plan's file groups; verify, re-review the fix commits until green before any reply is posted. Without the Workflow tool (Codex, OpenCode) the main session sifts by hand, then validates. Use after a review or audit, on PR comments, or to decide what to fix first. Triggers: address review comments, fix the findings, triage findings, what to fix first.
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

`⫲` marks a step that **fans out across subagents** (→ "Parallelism via subagents"). Triage is
not one of them: it is the main session's (→ "Who triages").

```
0. Recall    — mandatory, before any triage, also when subagents fix:
               the author's PR-thread rejections recorded first (→ pr-rejections.md),
               then `memory` recall(topic, scope) for every path the findings touch, for this
               skill's own triage — the review engines recall for themselves (→ below),
               then findings that recur across branches shown, a lesson offered per group (→ below);
               a recall that fails or errors here is one line (`memory: recall failed — <why>`),
               never a reason to skip or replace the triage workflow, which recalls for itself
1. Gather    — name the sources for the triage workflow, which reads them itself; at least one:
               • a report: a review engine's report, a rust-audit report, a rust-reviewer
                 verdict → whenever the findings live in one, written to a file in the
                 session's temporary directory if it lives only in the session, passed as
                 `report`
               • GitHub: whenever there is a PR, its number, passed as `pr` (it reads the
                 inline thread comments only; → github.md)
               the PR-thread rejections are read here too (step 0). Only without the Workflow
               tool does the session collect the findings itself, a subagent per source if
               they are many
   Steps 2–4 are the `craft:triage-findings` workflow, launched by the main session
   (→ "Who triages"); the lines below say what it does, and what the main session does
   itself only where there is no Workflow tool.
2. Normalize — to the unified schema; tag source; compute stable_id        (→ schema.md)
2b. Sift     — before any validator: repeats in the batch collapse onto one; a finding an
               active decision, deferred question or project rule (step 0) already answers is
               settled from memory — rejected / deferred, citing who, when and the link; a
               Critical/High one, or one whose record's code changed since its commit, goes on
               to triage; one that goes against a record is a `conflict` for the human
               (→ "The sift before triage")
3. Triage    — per finding, validated against a pinned ref (the workflow fans out its own
               validators — never one subagent per finding of yours):
               accept / reject / defer / needs-decision / conflict (+ reasoning),
               and its noise class (→ "Noise classes"); a finding the PR did not
               introduce → an issue, no question asked (→ "Not this PR's — an issue")
4. Order     — accepted only: blocking → simple → complex; group by file to cut churn
               (the grouping is what makes step 5 parallelisable — independent groups)
5. Fix     ⫲ — list every place the violated property lives, then patch them  (→ below)
               independent file-groups of the workflow's plan fixed concurrently, one subagent
               per group, briefed with the plan's verdicts — it fixes, never re-triages, never
               writes memory (worktree isolation when groups could touch shared files). Within a
               group, serial. "How to fix" → topic skills; a bug → regression test
               first, RED→GREEN                                                (→ rust.md)
6. Verify    — per fix: every facet · your own check · sibling sweep ·
               falsify per element · bounds reached                           (→ below, rust.md)
7. Re-review — a gate, in the main session, once every fix has landed (each fixer subagent
               returned, its fix committed — pushed where there is a PR). Light by default: it
               reviews only the fix commits, from the commit the addressed review was made on
               (its base) to HEAD. That base is, for a GitHub PR review, the review's `commit_id`
               (`gh api repos/<owner>/<repo>/pulls/<N>/reviews` → `.commit_id`; for inline
               comments `.../pulls/<N>/comments` → `original_commit_id`, else `commit_id`; several
               reviews → the oldest), and for a previous engine run, the HEAD it reviewed. Check
               `git merge-base --is-ancestor <that commit> HEAD`; if it fails (a rebase, a
               force-push, the commit missing), say so and ask the human — the full PR review
               only on their word. Then check `git rev-list --merges <that commit>..HEAD`; if it
               lists a merge (trunk or another branch merged in since the review), the diff from
               that commit carries the merged code too, not the fix commits only: say so and ask
               the human: the whole PR (`base: <trunk>`, still `fresh: true`), or the fix
               commits named, or a base after the merge. Run the `craft:review` workflow on a Rust or Nix diff with
               `{ base: <that commit>, fresh: true, fullEvery: 0 }` when the findings did not
               come from its last round on this branch (a human's PR review, any other review):
               `fresh` keeps it from chaining to an older run on the branch, which would widen
               the scan and carry that run's settled findings; when they did, chain as `develop`
               does (Phase 4, a later light round). Run the `craft:adversarial-review` workflow on
               any other diff with `{ diffBase: <that commit> }`. Add `repo` and `intent` as
               usual; one run per PR. The findings the fixes touch were checked in step 6;
               `craft:review` re-checks its previous round's where it chains. The whole diff only
               on the human's word, or as the final pass the repo's rules ask for. Never handed to a subagent (it has no Workflow tool). Without the Workflow
               tool (Codex, OpenCode) the re-review is this session's own review pass over the fix
               commits (`git diff <that commit>..HEAD`), with the `rust-review` or `nix-review`
               rubric where it applies.
               PR-thread rejections recorded again; the review workflow recalls the active
               decisions and questions itself on every launch — `priorDecisions` (an object
               argument, each record with its `kind`, `title` and `scope`; the `id` may be left
               out, the engine derives it by the memory skill's rule) only ADDS records the store
               may not hold yet, never replaces that recall (→ `memory`, "Before a review");
               new findings go back through the triage workflow (steps 2–4), then steps
               5–6; the ledger dedups; repeat until
               no Medium-or-higher finding is open (→ rust.md)
8. Close loop— (GitHub) draft replies (what was fixed / why rejected + commit); drafts may be
               written during step 7, but none is posted before the re-review is green (or
               the human waives it), and a reply may cite that run. Post & resolve ONLY after
               explicit user OK; map reply→thread via thread_id (→ github.md)
```

## Who triages

**The main session, through the `craft:triage-findings` workflow — whatever the batch size**, one
finding or a fat `rust-audit` report. The sift, the noise classes and the not-this-PR issue list
live in that workflow; triage done anywhere else skips them, and project memory then never fills.
A subagent launched with the Agent tool has no Workflow tool, so triage is **never handed to a
subagent** — not "triage and fix the review", not "triage these findings": the main session runs
the workflow, then briefs subagents with the fix work only (step 5).
If `craft:triage-findings` or `craft:adversarial-review` fails with `at workflow.js:<line>:<column>`,
that place is in the bundled engine:
`node "<this skill's base directory>/../../lib/engine-source-map.mjs" <engine> workflow.js:<line>:<column>`
gives it in the plugin's source.
Once a run of either has ended (completed, failed or stopped — not while you may still resume it),
fold its real cost into the records it filed:
`node "<this skill's base directory>/../../lib/craft-log-run.mjs" enrich-cost --run-id <wf_…>`, with the
run id the Workflow completion names. Best-effort: if it fails, say so in one line and go on.

Launch it with its sources — `report` = a path to the findings whenever they live in a report (one
that lives only in the session is written to a file in the session's temporary directory first),
and `pr` = the PR number whenever there is a PR (it reads only the PR's inline threads, so a
report's findings reach triage only through `report`); at least one — the workflow refuses to run
with neither — and `prBase` = the output of `git merge-base origin/<trunk> <reviewed head>` (the commit
the PR forks from), only when the reviewed head is a branch diverging from trunk (that merge-base
differs from the head), and with it `base` = the reviewed head's SHA: only there can a finding be
shown not to be this PR's. On trunk or with no branch (a `rust-audit` of trunk) leave `prBase` out —
the workflow counts it only beside a `base` it differs from, so one with no `base`, one equal to
`base`, or `HEAD` is absent — and every such finding goes to you as `needs-decision`. `base` keeps
its meaning — the ref the findings were generated against, the reviewed head, which validation pins to. When the
findings are in another repository than the session's, add `repo` = its absolute path, as for the review. The workflow sifts by memory itself — it recalls the
project's records for the findings' paths and merges in what `priorDecisions` (an object argument,
the step-0 records) adds; its ledger rows with `sifted: true` (their reason opens with `SIFTED
BEFORE VALIDATION`) were settled by the sift — a repeat or a record's answer — not judged on the
code. It returns the plan (accepted findings grouped by file), the ledger and `issues` (title, body)
for the findings that are not this PR's. A failed recall in this session (step 0) does not mean the
workflow has no memory: say it in one line and launch the workflow anyway.

**Right after it returns, the main session** — not a subagent — writes every disposition to memory
(each `reject` as a decision, each `defer` and `needs-decision` as a question, the PR-thread
rejections as decisions, `sifted` rows excepted; → "Project memory"; a finding kept but justified in
the PR body is recorded as a decision later, when that is written), files the `issues`
(→ "Not this PR's — an issue"), and only then hands the plan's file groups to fixers.

**Entered with a plan already made** — when the caller has already run the workflow, recorded its
dispositions and filed its issues (`develop`'s round does this in its triage step), this skill is
entered at step 5 with the plan in hand: steps 0–4 are skipped — no second recall, sift, triage or
memory write, since a second sift would see the first's fresh records and set its own findings
aside — and steps 5–8 run as usual (`develop` stops after step 6). A disposition that changes while
fixing (a planned fix turns out wrong) is re-decided and recorded then, once.

**Without the Workflow tool** (Codex, OpenCode) there is no sift engine: the main session — still
never a subagent — does the sift's steps itself from this text first: recall for every touched path
(step 0); set aside a finding an active decision, deferred question or project rule answers,
citing it; raise again every Critical/High one and every one whose record's code changed since its
commit; collapse repeats. Then it validates what is left: inline, or in OpenCode with its
`triage-findings` tool (which validates and plans but does not sift — never a replacement for the
steps above); either way it names each noise class and turns a finding the PR did not introduce into
an issue. Say plainly in one line that the sift ran by hand because there is no Workflow tool.

## The sift before triage (step 2b)

Before a single finding is validated, memory answers what it already settled — so a finding
decided in another PR is not decided again, and the opposite way:

- **Repeats** — the same finding under another id in the same batch (same thread, or same file
  within a few lines and the same title words) is one finding: the most severe copy goes on, the
  rest are rejected as its repeats, each row naming that copy in `repeat_of` — in the review
  ledger a repeat takes its copy's disposition, not its own `reject` (below).
- **Answered by memory** — a finding an active decision answers is `reject`, one a deferred
  question answers `defer`, one a project rule covers `reject`; the ledger reason cites the
  record (who, when, link) and how it matched. Matching is the review engine's own: the anchor or
  title in the record's scope, and a judge for the doubtful pairs — never a guess by topic.
- **Raised again** — a Critical or High finding is never settled from memory, nor one whose
  record's code changed since the record's commit (or that has no commit): it goes to triage
  with the record cited.
- **Against a record** — a finding that shows the code going against what a record settled is a
  `conflict`: the human decides whether the record still stands.

## Noise classes

Triage names, besides the verdict, why a finding is noise rather than a defect of this change —
judged on the code, never on the reviewer's own label:

| Class | What | Verdict |
|---|---|---|
| 1 | not this PR's — the problem stands at the base (the diff did not bring it), or lies outside the PR's task | a real problem: `defer`, carried by an issue (below) — checked at the PR's fork point the triage was given as `prBase` and no other ref (`git show <prBase>:<path>` named in the premise; HEAD, the validation `base`, another branch or the bare word merge-base shows nothing, and with no `prBase` given a human decides), never on the reviewer's "pre-existing"; not a real problem: `reject`, no issue |
| 2 | inflated severity — the harm is unreachable or heals itself (a default requeue, only a metric) | judged on the merits, severity lowered |
| 3 | a repeat — the same finding under a new id, or decided in another PR | settled by the sift |
| 4 | a deliberate trade-off written in the project's docs or rules | `reject`, naming where it is written |
| 5 | not decidable from the code — a rollout step, an unverifiable version | `needs-decision`, not a fix |
| 6 | an optional nicety in tests or comments | planned apart from the defects |

## Not this PR's — an issue

A real class-1 finding is not fixed in this branch and not asked about: it goes to an issue on the
project's forge, filed by this loop without a question (the human closes what is not needed).
Search the open issues first (`gh issue list --state open --search "<title words> in:title,body"`);
one about the same concern → comment the finding there (`gh issue comment <n> --body …`), else
`gh issue create --title … --body …` (the workflow's `issues` carry both). Then record the
deferral in memory at once — `record-question`, `deferred: true`, links = the issue URL first, then
the PR thread — and draft the thread's reply with the issue link: like every reply, it is posted
only on the human's explicit OK (step 8). No `gh` or no forge → record the deferral, say in one
line that no issue was filed and why.

## Triage outcomes

Validate each finding against the code (pinned to the ref it was generated against), then:

| Verdict | Meaning | Where it goes |
|---|---|---|
| `accept` | real, in scope | into the plan |
| `reject` | wrong / not a real problem | ledger + drafted pushback + a decision in `memory` |
| `defer` | valid but out of scope now | ledger (stays deferred across runs) + an open question in `memory`; not this PR's → also an issue |
| `needs-decision` | valid but needs a product/spec call, **or** has no resolvable location | → `specs` |
| `conflict` | contradicts another finding, or goes against a record in memory | surfaced for a human; never silently pick one |

**Locationless findings** (file- or PR-level comments) get an explicit lane: resolve a concrete
location during triage, else route to `needs-decision` — never drop them silently.

`reject` → `rejected` and `defer` → `deferred` are also written back to the **review ledger** so
the next re-review carries them forward (→ "Writing dispositions to the review ledger").

## Project memory — recall before, record after

The review ledger is per branch and machine-local; the *reason* a finding was dismissed is a fact
about the project that should outlive the branch. The `memory` skill keeps it (whatever backend
the project has; it prints `memory backend: …` once).

**Write a disposition the moment it is made — never ask whether to.** The author's reject,
justify or defer *is* the decision; recording it is bookkeeping, not a second question. Invoke the
`craft:memory` skill with the verb below, then print one line per write:
`memory backend: <X> — recorded <kind> <id> (<title>)`. No backend available (the skill says
`none`) → one line `memory: no backend available — <why>; not recorded` and carry on with the
loop; a refused or failed write is named the same way. Every record carries `kind`, `title` and
`scope` — the id is derived from them (the `memory` skill's rule; a review engine derives a missing
one itself). Only a **lesson** waits for the author's yes (below).

- **Before triage (step 0)** — `recall(<finding keywords>, <path>)` for every touched path. A
  matching **active** decision is known context: a finding it already answers is triaged with that
  reason cited (and its id), not re-litigated — unless the code the decision relied on has changed,
  in which case say so and supersede the decision instead of applying it. A matching **active
  question** on the finding's title means it was deferred before: cite it, and either keep it
  deferred or answer it (a decision that supersedes it).
- **No record for a row the sift set aside** — a ledger row with `sifted: true` gets neither
  `record-decision` nor `record-question`, whatever its verdict (`reject` or `defer`). A row set aside
  by a record (rejected or deferred before, under a project rule) is already answered by that record,
  and a new one at HEAD would renew the stale record's commit and blind the next sift's check that the
  scope changed since it. A row that repeats another finding of this batch is settled by the record
  written for the finding it repeats (its reason names that id); a record of its own would duplicate
  that one. Tell such rows apart by the field, never by the reason's wording. Recording one is right
  only when the human re-decides it.
- **On a disposition** — `record-decision` with title = the finding's title (for a gate tool's finding without toolRule, the title the report lists for its `file:line` under **Tool finding titles (verbatim)** — the one equal to the report line's text, or the only one listed there; when several are listed and none is equal, the report line's text, never a guess between them, and the finding then goes to the judge each round; when none is listed there (a PR thread, an older report), the review ledger row's `title` only when the ledger holds exactly one live gate-tool row without toolRule at that `file:line` (live: `disposition` other than `closed` — a `closed` row is a tombstone, not a row of a finding) — several there (two deadnix bindings on one line) is no source: never pick between them — else the report line's text, which then goes to the judge each round; any other finding's title as the report printed it; never from a refusal note, which clips titles), scope = its file path
  (the component, or `.`, for a locationless finding), body = the reason, author = who decided
  (the user, or the PR author whose reply it was), commit = `git rev-parse HEAD` at triage, line =
  the finding's line, lens = the lens that raised it (the review ledger row's `source` / `sources` — the engine's lens names; the record's `lens` comes from the finding's lens, never from the normalized finding's `source`, which names only where it came from: `review`, `adversarial-review`, `rust-audit`, `rust-reviewer`, `nix-review`, `report` or `github-pr`; or
  adversarial-review's `lens`; leave either out when the finding has none), toolRule = the gate
  tool's own rule name — a clippy lint, a semgrep rule id, a statix code — read, like the lens, from
  the review ledger row's `toolRule` (else from the report's brackets — only the part labelled `tool:`,
  as in `[MNT-001 · tool: W04]` or `[tool: W04]`; a bracket without `tool:` is a catalog ruleId, never a
  toolRule — or the PR comment's `craft-tool-rule` line), copied as it stands; a tool's finding
  matches a record outright only on the same toolRule; leave it out when none of these names one,
  never fill it from memory. A gate tool's finding without toolRule — deadnix and fmt always, any lint
  the review printed without a `tool:` rule — is told apart by its title alone: copy the title exactly
  as that source carries it, never reworded, since only the same title sets it aside when the judge
  gives no verdict (deadnix names the binding there)), links = PR / thread / commit. Triggered by triage `reject` and a finding kept but `justified` in the PR
  body — written right then, without asking. The PR-thread rejections `pr-rejections.mjs` prints
  (→ pr-rejections.md) are written the same way, each as it is.
- **A stance is a project rule, not a decision** — when the reason for a reject is a stance of the
  whole project rather than "this is not a bug here" ("we do not support rollback", "a new API
  without consumers may break", "this crate is released on demand"), it covers every finding of
  its class, and a decision on one finding would not: `record-rule` with title = the stance as one
  statement, scope = the folder, component or `.` it holds for, body = why, author = who said it,
  links = where; `lens` only to narrow it to one lens's findings (e.g. `compat`). The rule needs
  the human's word that it is a stance — ask in words when the reason reads like one and they did
  not say so; without it, record the decision as above. The finding at hand still gets its
  decision; the next review lists the rest of the class under **Covered by project rules**.
- **A deferral is an open question, not a decision** — triage `defer` becomes `record-question`
  with title = the finding's title (from the same source as a decision's), scope = its file path, body = what would answer it (the event,
  the change or the call that would settle it), author = who deferred, commit = `git rev-parse
  HEAD` at triage, line, lens and toolRule = the finding's (as for a decision), links = the PR and the comment
  URL, and `deferred: true` — the field that makes
  the question a deferral (a question without it is context only and sets nothing aside) —
  written right then, without asking. The next review lists that finding under
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
  runs never count, and only findings verified real and not already settled do — a row rejected as
  wrong, a refuted one, a justified or dismissed one, one a project rule covered, a deferred one (a known defect carried under
  an open question) and one no verifier confirmed (unverified or suspected) are left out (the `note`
  says so). `--store <dir>` reads another store (default `~/.craft/runs`), `--project
  <dir>` another checkout. Its `note` names every bound it reached (the newest 500 runs read, 20
  groups listed) — repeat that line, never present a cut list as whole.
  Show each group (file, titles, branches, when last seen) and **ask the author, per group**,
  whether to record a lesson. Yes → `record-lesson` with scope = the file, title = the pattern in one
  line, body = the pattern and what avoids it (in the author's words), links = the runs or PRs.
  No answer or no → write nothing. No run store, or no group → say so in one line
  (`recurring findings: none — <the note>`) and continue.
- **Subagents** (fix only — triage is never theirs) lack the memory tools and never write memory:
  the launcher puts the matching records, verbatim with ids, and the plan's verdicts into each
  brief. Every disposition is written by the main session right after the triage workflow returns;
  a fixer that finds a planned fix wrong reports it back, and the main session re-decides and
  records it. Known limit, not a gap to route around.

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
   - a `sifted` row is **never** mapped by its own `reject`: no one judged it on the code.
     A repeat (`repeat_of` names its twin) takes its twin's disposition as the twin's row maps
     — `closed` when the twin's fix landed and was verified **and** reached the repeat's line too
     (else leave `open`), `deferred` when the twin is deferred, `rejected` only when the twin is
     rejected. Any other sifted `reject` (a record's answer) → leave `open`: the next review sets
     it aside again from the recalled record, and drops that once the record is withdrawn.
3. **Match** a fix-loop finding to a review-ledger entry by `fp` when the finding carries one;
   otherwise by `file` + `ruleId` + a title match. If no entry matches, skip that finding silently.
4. **Why:** this is exactly what lets the next round-aware re-review's *adjudicate track* **carry**
   dismissed (`rejected` / `justified`) findings forward instead of re-raising them, and treat
   `closed` ones as resolved (→ Re-review, step 7; the round-aware `craft:review` workflow).

## Parallelism via subagents

Where craft's fix loop fans out across subagents:

- **Gather (1)** — not a fan-out where the Workflow tool exists: the triage workflow reads `pr` and
  `report` itself. Only without it (Codex, OpenCode) may independent sources go to one subagent per
  source, whose output the main session then sifts and triages.
- **Triage (2–4)** — not a fan-out of yours: the main session launches the `craft:triage-findings`
  workflow, which fans its own validators out (→ "Who triages").
- **Fix (5)** — the workflow's plan is grouped by file so **independent groups run concurrently**,
  one subagent per group, each briefed with its group's verdicts and recalled records; worktree isolation only when groups could touch shared files. Within a
  group, serial.
- **Re-review (7)** — not a fan-out of yours: the main session launches the review workflow, which
  fans its own lenses out.

## Rust wiring

Which agents to re-dispatch, the fix-to-skill routing, and the "what proves what" proof table →
[rust.md](rust.md).

## Doubtful findings a review held back

A review run with `comment` posts only defects; its **Doubtful — for the reviewer, not posted**
list goes to the human, who chooses for each: ask the author, post it as a defect, or do not post
it. A chosen one is posted only through `lib/finding-post.mjs`, with the marker; a "do not post" is
written to memory at once (a decision, or a project rule when the reason is a stance); the author's
answer on a question thread is read by the thread rules → [doubtful.md](doubtful.md).

A finding listed under **Contradicts project memory** (`adversarial-review`: its `contradictsMemory`
field — that engine posts nothing, so it sorts nothing) goes against an active decision or project rule:
it is a defect, never a doubt. Fix it, or — on the human's word — supersede the record it breaks; do not
reject it on the record's own authority.

## The author's rejections on the PR

Before the loop works the findings, what was already rejected on the PR — a reply that opens with
"not a bug" / "by design" / "won't fix" … — is recorded as decisions with the author, the comment
URL and the commit, without asking. That holds for a craft finding's thread and for any other
reviewer's — a person's remark or their own tool's — so the same remark in the next PR is sifted
out. Conservative: only when that explicit reply is the last word, from an owner, member or
collaborator of the repository — or, in a craft finding's thread only, from the PR author; in
another reviewer's thread a PR author without that association never settles the remark. A thread
resolved without a reply is never a rejection.
The rule, the `gh` query and the script → [pr-rejections.md](pr-rejections.md).

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
