---
name: develop
description: >-
  Run a change in this repository end to end up to a pull request with craft's own tools — read the project's declared roles and rules first and let them take any phase they cover, recall project memory for the touched paths, make the change, loop review → triage → fix until a round brings no open Medium-or-higher finding (at most 4 rounds, then stop and tell the human), run one full review, and open the PR only after that. Loaded in the main session, never delegated to a subagent (subagents have no Workflow tool; a --agent session is a main one); craft's SessionStart hook points a repo's declared developer role here. Use when asked to implement a feature or fix and open a PR, develop something end to end, or take a change from request to PR. Triggers: implement this and open a PR, develop X end to end, take this to a PR, do the whole cycle. Not for working existing findings only (addressing-findings), a one-off review (the review workflows), or how to plan, test or debug (bring the project's own process).
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
speaks of review, commits, branches or PRs): the repo's roles and rules win on every step they
cover, its developer role runs this cycle with craft's tools, and a role running as a subagent hands
the review loop back to the main session. It is silent in other repos; `CRAFT_ROLE_HOOK=0` in the
environment, or a line `craft-role-hook: off` in `AGENTS.md` / `CLAUDE.md`, switches it off.

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
         · 6 PR: <rule | craft default>
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

| Diff | Engine | Base argument |
|---|---|---|
| Rust and/or Nix only | the `craft:review` workflow (auto-detects Rust/Nix) | `base` |
| anything else, or mixed with other languages | the `craft:adversarial-review` workflow | `diffBase` |

(`craft:review` on a diff with no Rust or Nix returns `INCOMPLETE (no language profile)` — do not
use it there.)

One **round** is:

1. **Review** — launch the engine with an object argument, `{ base | diffBase: <trunk>, priorDecisions?: [...] }`.
   The engine recalls the project's active decisions, questions and project rules for the diff's paths itself on
   every launch. Pass `priorDecisions` only for records the store may not hold yet — rejections
   just read from PR threads, or a decision from this loop whose write failed — verbatim, each with
   its `kind`, `title` and `scope`; never as a string (it is refused).
2. **Triage** — a large report → the `craft:triage-findings` workflow; a small one → inline, as
   `craft:addressing-findings` describes.
3. **Address** — `craft:addressing-findings` works the findings through its step 6 (verify): fixes
   the accepted ones, writes every rejection or justification as a decision and every deferral as an
   open question in project memory at once, without asking. Stop it there: its re-review (step 7) is
   this loop's next round, and its PR-thread replies (step 8) have no PR yet. Gate green and commit
   again before the next round.

**Count the rounds, and stop on one of these — nothing else ends the loop:**

- **Converged** — the round's review returned a verdict and raised **no open finding of Medium
  severity or higher**. *Open* means not set aside by a decision or deferred question in memory, nor
  covered by a project rule (the report's **Rejected before** / **Known and deferred** / **Covered by
  project rules**) — a Medium+ finding raised again
  after its fix holds the loop like a new one. Low findings never hold the loop. → go to phase 5.
- **Round 4 ended without converging** — stop. Tell the human what is left: each open Medium+
  finding (title, file, severity, why it is still open) and the rounds' verdicts. **No PR** without
  the human's word.
- A round **without a verdict** — the engine returned `INCOMPLETE`, died, or is not available — is
  not convergence and does not count as a clean round. Say what did not run. Retry the review once
  if the cause is transient (the retry is the same round); still no verdict → stop as above and
  tell the human.

A declared reviewer that reports no severities cannot show convergence by itself: ask it for
severities on its findings, or treat each of its findings as Medium.

Print one line per round: `develop: round <n>/4 — <engine> verdict <V>, open Medium+: <k> (<titles>)`.

## Phase 5 — Full review

Only after the loop converged. The project's declared reviewer (or its rule for the last review
before a PR) when there is one; otherwise by stack, once, over the whole branch diff:

| Diff | Full review |
|---|---|
| touches Rust | the `craft:rust-audit` workflow, `{ base: <trunk> }` (it reviews the Rust part only) — and, when the diff also holds Nix, the `craft:nix-review` workflow with `{ base: <trunk>, strict: true }`; when it holds code other than Rust and Nix, the `craft:adversarial-review` workflow over it |
| Nix only | the `craft:review` workflow with `{ base: <trunk>, strict: true }` — the harsh maintainability bar |
| anything else | the `craft:adversarial-review` workflow, `{ diffBase: <trunk> }`, a fresh run over the whole branch |

`adversarial-review` has no strict mode; `strict` belongs to `craft:review` only.

Findings from the full review go through `craft:addressing-findings` like a loop round. An open
Medium+ finding here reopens phase 4 within the same 4-round budget (the rounds already spent
count); a full review without a verdict is handled as in phase 4.

## Phase 6 — PR

Only after phase 5 ended clean — or on the human's explicit word when the loop did not converge.
Follow the project's PR rules (title form, body sections, what must be linked, who opens it, draft
or not); none declared → title in the repository's commit style, body naming what changed, the
loop's rounds and verdicts, the full review's verdict, and each finding left open with why. The
project's rules on pushing and opening PRs (and on asking first) apply unchanged.

## Boundaries

- Working an existing set of findings, without the rest of the cycle → `craft:addressing-findings`.
- A single review of a diff → the review workflows directly.
- Recording or recalling a single fact → `craft:memory`.
- Planning, test-first, debugging method, verification discipline → the project's own process;
  craft does not ship one.
