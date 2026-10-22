---
name: develop
description: >-
  Run a change end to end up to a pull request with craft's tools — read the project's declared roles and rules first and let them take any phase they cover, recall project memory for the touched paths, make the change, loop review → triage → fix — the first round over the branch diff, each next over the fixed delta only — until a round brings no open Medium-or-higher finding (at most 4 rounds, then stop and tell the human), run one full review, record the cycle, and open the PR only after that. Needs Claude Code's Workflow tool (not in Codex, OpenCode or a subagent): main session only; the SessionStart hook points a declared developer role here. Use when asked to implement a feature or fix and open a PR, or take a change from request to PR. Triggers: implement this and open a PR, develop X end to end, take this to a PR, do the whole cycle. Not for working existing findings only (addressing-findings), a one-off review (the review workflows), or how to plan, test or debug (bring the project's own process).
---

# Develop — the cycle up to a PR

One change, from the request to an opened PR, run with craft's own tools: project memory, the
review engines, triage and the fix loop. The skill owns the **order of phases and when each ends**.
It does not own how to plan, test or debug — that is the project's own process, or the craft topic
skill that already exists for it.

## Where it runs

In the **main session**. The review engines are Workflow-tool scripts, and a subagent launched with
the Agent tool has no Workflow tool — so never hand this skill, or a phase that launches an engine,
to a subagent. Subagents may still do bulky work inside a phase (a coding role, a triage fan-out).
A session started with `claude --agent <role>` is a main session with that role's prompt: when the
role's `tools` list is empty or names `Workflow` and `Skill`, it runs this cycle itself.

In Claude Code, craft's SessionStart hook says this at the start of a session in a repo that
declares its own agents (`.claude/agents/*.md`) or work rules (an `AGENTS.md` / `CLAUDE.md` that
names the process: pull request, PR, code review, reviewer, review loop, before merging): the repo's
roles and rules win on every step they cover, whichever declared role develops there runs this cycle
with craft's tools, and a role running as a subagent hands the review loop back to the main session.
It is silent in other repos and on a resumed session; `CRAFT_ROLE_HOOK=0` in the environment, or a
line `craft-role-hook: off` in `AGENTS.md` / `CLAUDE.md`, switches it off. In the same repos it speaks
again at the moment of work: on a message asking for work on findings or PR comments it names
`craft:addressing-findings`, and on one asking for a review it names `craft:review` and this skill,
both run in the main session; either way the main session puts the recalled records into each
subagent's brief and records every rejected or deferred finding a subagent reports, and it gets a
ready line for the brief; a subagent started in that session hears that the review loop is the main
session's.

## The rule over every phase: the project's process comes first

Before anything else, find what the project already declares for each phase. **A declared role or
rule takes its phase; craft runs a phase only where the project declared nothing.** A declared rule
that conflicts with a default below wins (its review order, its gate command, its PR form, its
reviewer). Never skip a declared step because craft has its own.

## Phase 1 — Consumer roles

Read, without changing anything:

- `.claude/agents/*.md` and `.opencode/agents/*` (or `.opencode/agent/*`) — roles the project
  declares: a coder / implementer, a reviewer, a verifier, a gate runner.
- `AGENTS.md` / `CLAUDE.md` (root and nested ones on the touched paths) — rules on how work is done,
  branch and worktree rules, the gate command, the review order, commit and PR form, what needs the
  human's word.

Then print one line per phase, before starting phase 2:

```
develop: roles — 1 roles: craft (read) · 2 recall: craft:memory · 3 work: <role or rule | craft session>
         · 4 review loop: <role/rule | craft:review | craft:adversarial-review> · 5 full review: <…>
         · 6 record: craft · 7 PR: <rule | craft default>
```

Each slot names the file the role or rule came from (`.claude/agents/reviewer.md`, `AGENTS.md §Git`).
Nothing declared → say `craft`. Two declarations that disagree on one phase → ask the human which
holds; do not pick.

## Phase 2 — Recall

Invoke the `craft:memory` skill: `recall(<topic of the change>, <each path the change will touch>)`
— the paths you expect to touch now, and again for any new path once the diff exists. It prints
`memory backend: X (why)`. An active **decision** on a path is context for the work (do not redo
what was rejected for a stated reason; if the code it relied on changed, say so). An active
**question** is something still open there — name it to the human if the change would answer it.
Keep the recalled records verbatim with their ids: subagents get them in their brief (they cannot
recall themselves).

No backend → one line `memory: no backend available — <why>` and continue.

## Phase 3 — Work

The change itself, on the branch the project's rules call for (its worktree rule, its branch naming).
Through the project's declared coding role when there is one — its brief carries the request, the
recalled records and the project's rules; otherwise in this session. How to plan, test-first or
debug is the project's own process; where craft already has a topic skill for the language or the
problem (`craft:rust-testing`, `craft:debugging`, `craft:refactoring`, …), use it — this skill adds
none.

Finish the phase with the project's gate green (its declared command), the work **committed** on the
branch, and the tree clean: a review engine reviews uncommitted changes instead of the branch when
the tree is dirty.

## Phase 4 — Review loop until convergence

The review here is the project's declared reviewer or review rule when there is one. Otherwise the
engine is chosen by the stack of the branch diff (`git diff --name-only <base>...HEAD`):

| Diff | Engine |
|---|---|
| Rust and/or Nix only | the `craft:review` workflow (auto-detects Rust/Nix) |
| anything else, or mixed with other languages | the `craft:adversarial-review` workflow |

(`craft:review` on a diff with no Rust or Nix returns `INCOMPLETE (no language profile)` — do not
use it there.)

**The loop is light by default.** The first round reviews the whole branch diff; every later round
reviews only the delta the fixes changed, together with the findings that delta touched — not the
whole diff again. The whole diff is reviewed once more, in phase 5. Only on the human's word ("full
rounds") does every round review the whole branch diff. Before each round, note `git rev-parse HEAD`
— the commit that round reviews.

The engine's argument for each round, as an object (never a string):

| Round | `craft:review` | `craft:adversarial-review` |
|---|---|---|
| 1 | `{ base: <trunk>, fresh: true, fullEvery: 0 }` | `{ diffBase: <trunk> }` |
| 2 and later, light | `{ base: <trunk>, fullEvery: 0 }` | `{ diffBase: <HEAD the previous round reviewed> }` |
| 2 and later, full rounds | `{ base: <trunk>, fresh: true }` | `{ diffBase: <trunk> }` |

- `craft:review` keeps the loop's memory itself: `fresh` on round 1 starts a new chain (an older run
  on this branch is not this cycle's round), and each later round chains to the one before it,
  scans the fix commits only (`fullEvery: 0` turns off its periodic whole-diff rescan) and checks
  every finding the previous round left open again — whether it was fixed, is still there, or came
  back. Its light row holds only when the findings are this loop's previous round: it chains to the
  newest earlier run on the branch, whatever made the findings. Findings from elsewhere (a human's
  PR review) take `craft:addressing-findings` step 7's arguments: the commit that review was made on
  as `base`, with `fresh: true`.
- `craft:adversarial-review` keeps no memory between runs. Its light round reviews the delta only;
  a finding of the previous round stays **open** unless the fix that addressed it is in that delta
  and `craft:addressing-findings` verified it (its step 6), or a decision or deferred question set
  it aside. Carry the open ones into the round's count yourself.
- Add `priorDecisions: [...]` to either only for records the store may not hold yet — rejections
  just read from PR threads, or a decision from this loop whose write failed — verbatim, each with
  its `kind`, `title` and `scope`. The engine recalls the project's active decisions, questions and
  project rules for the diff's paths itself on every launch.
- `craft:review` also takes `depth` and `extraLenses` (not in the table: the loop leaves both at
  their defaults unless the human asks). `depth: 'light'` is a cheaper pass, not the light loop
  above: one round of the diff-scoped lenses only (no negative-space, compat, invariants or
  failure-windows lens; `tests` and `intent` still run whenever the diff changes production code),
  no completeness critic, and only Medium and above verified; its verdict says light pass and its
  report names what it skipped. The default, `depth: 'full'`, is the whole review. The engine
  accepts only `depth: 'light'`; any other value runs full. Deciding that a "quick" or "light"
  request means `depth: 'light'` is the job of the skill or hook that launches it, not the engine's.
  `extraLenses` runs the repository's own reviewing agents as lenses in the same run, their
  findings verified and counted with the rest: on a light pass with the argument absent, the engine
  finds them itself among the `.claude/agents` of the project the session runs in, only when
  `repo` is absent or names that project or one of its worktrees; on a foreign `repo` discovery is
  skipped and the report says so (agents that review and have no edit
  tool; each is told to stay read-only; the report says when there is none); a full review runs
  them only when named. `extraLenses: ['<agent>', ...]` names them at either depth;
  `extraLenses: []` turns them off. A named agent that does not exist or fails is a coverage gap in
  the report, and the run still completes; on an empty or docs-only diff it is listed as not needed.
  A discovered agent that cannot run is reported as such and is no coverage gap.

One **round** is:

1. **Review** — launch the engine with the round's argument above.
2. **Triage** — a large report → the `craft:triage-findings` workflow; a small one → inline, as
   `craft:addressing-findings` describes.
3. **Address** — `craft:addressing-findings` works the findings through its step 6 (verify): fixes
   the accepted ones, writes every rejection or justification as a decision and every deferral as an
   open question in project memory at once, without asking. Stop it there: its re-review (step 7) is
   this loop's next round, and its PR-thread replies (step 8) have no PR yet. Gate green and commit
   again before the next round.

A finding marked as going against a project-memory record (`craft:review`'s **Contradicts project
memory** section; `craft:adversarial-review`'s `contradictsMemory` field, the same lines) is a defect: fix it, or change the record with the human's word — never reject it
as a doubt.

**Count the rounds, and stop on one of these — nothing else ends the loop:**

- **Converged** — the round's review returned a verdict and **no finding of Medium severity or
  higher is open**: none raised by this round, and none carried open from an earlier round. *Open*
  means not set aside by a decision or deferred question in memory, nor covered by a project rule
  (the report's **Rejected before** / **Known and deferred** / **Covered by project rules**) — a
  Medium+ finding raised again after its fix holds the loop like a new one. Low findings never hold
  the loop. → go to phase 5.
- **Round 4 ended without converging** — stop. Tell the human what is left: each open Medium+
  finding (title, file, severity, why it is still open) and the rounds' verdicts. **No PR** without
  the human's word.
- A round **without a verdict** — the engine returned `INCOMPLETE`, died, or is not available — is
  not convergence and does not count as a clean round. Say what did not run. Retry the review once
  if the cause is transient (the retry is the same round); still no verdict → stop as above and
  tell the human.

A declared reviewer that reports no severities cannot show convergence by itself: ask it for
severities on its findings, or treat each of its findings as Medium.

Print one line per round: `develop: round <n>/4 (<whole diff | delta since <sha>>) — <engine> verdict <V>, open Medium+: <k> (<titles>)`.

## Phase 5 — Full review

Only after the loop converged, and once. The project's declared reviewer (or its rule for the last
review before a PR) when there is one; otherwise by stack, over the whole branch diff:

| Diff | Full review |
|---|---|
| touches Rust | the `craft:rust-audit` workflow, `{ base: <trunk> }` (it reviews the Rust part only) — and, when the diff also holds Nix, the `craft:nix-review` workflow with `{ base: <trunk>, strict: true }`; when it holds code other than Rust and Nix, the `craft:adversarial-review` workflow over it, `{ diffBase: <trunk> }` |
| Nix only | the `craft:review` workflow with `{ base: <trunk>, strict: true, fresh: true }` — the harsh maintainability bar over the whole diff (`fresh`: without it the run would chain to the loop and scan the last delta only) |
| anything else | the `craft:adversarial-review` workflow, `{ diffBase: <trunk> }` |

`adversarial-review` has no strict mode; `strict` belongs to `craft:review` only.

Findings from the full review go through `craft:addressing-findings` like a loop round. An open
Medium+ finding here reopens phase 4 within the same 4-round budget (the rounds already spent
count); the reopened rounds are light ones — their delta starts at the HEAD the full review
reviewed — and after it converges again the full review runs once more. A full review without a
verdict is handled as in phase 4.

## Phase 6 — Record the cycle

When the cycle ends — converged with a clean full review, capped at round 4, or stopped without a
verdict — file one record of it in craft's run store, from the reviewed repository on the branch:

```bash
node "<this skill's base directory>/../../lib/craft-log-run.mjs" develop-cycle <<'JSON'
{"mode": "light", "outcome": "converged",
 "rounds": [{"engine": "craft:adversarial-review", "scope": "full", "verdict": "Warning", "mediumPlus": 2},
            {"engine": "craft:adversarial-review", "scope": "delta", "verdict": "Approve", "mediumPlus": 0}],
 "fullReviews": [{"afterRound": 2, "engine": "craft:adversarial-review", "verdict": "Approve", "mediumPlus": 0}]}
JSON
```

`mode` is `light` or `full`; `outcome` is `converged`, `capped` or `no-verdict`; each round's
`scope` is `full` (the whole branch diff) or `delta`, its `mediumPlus` the open Medium+ count after
it (`null` for a round without a verdict); a declared reviewer is named as the engine. It prints the
file it wrote; a refusal names the field that does not fit — fix it and file again. A failure to
file is named in one line and changes nothing else.

## Phase 7 — PR

Only after phase 5 ended clean — or on the human's explicit word when the loop did not converge.
Follow the project's PR rules (title form, body sections, what must be linked, who opens it, draft
or not); none declared → title in the repository's commit style, body naming what changed, the
loop's rounds and verdicts, the full review's verdict, and each finding left open with why. The
project's rules on pushing and opening PRs (and on asking first) apply unchanged.

## Boundaries

- Working an existing set of findings, without the rest of the cycle → `craft:addressing-findings`.
- A single review of a diff → the review workflows directly.
- A review posting to an open PR (`comment`) posts defects only; its doubtful findings go to the
  human first → `craft:addressing-findings`.
- Recording or recalling a single fact → `craft:memory`.
- Planning, test-first, debugging method, verification discipline → the project's own process;
  craft does not ship one.
