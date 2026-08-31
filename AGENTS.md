# `craft`

A Claude Code plugin: an opinionated set of engineering skills (a broad Rust set, a Nix set, language-agnostic specs/debugging/refactoring/onboarding), review agents, and a review workflow engine.

## What this project is
- **Nature**: `production`. No relaxations — full discipline.
- **Realm**: `@nick/craft` (also addressable as `r209`) — every session starts with `iskron_orient` here.
- **Focus holon**: `#1` — the craft boundary.
- **Agent role**: `#3` — the craft engineer; adhikarin, steward of the focus holon. Your inbox: `iskron_orient(realm="r209", focus="#3")` at session start.
- **Owner role**: `#2` — the craft owner (svatantra 主); questions beyond your mandate go here as `posed_to` vimarshas.
- **Stack**: Node.js 22, plain ESM JavaScript with no runtime dependencies; skills and agents are Markdown with YAML frontmatter.
- **Production statement**: craft ships as a plugin through its own marketplace (`.claude-plugin/marketplace.json`) and **runs inside other people's repositories**, which it never sees. The cost of breakage is therefore external and silent: a skill with a wrong `description` never triggers and the method simply does not run; a review engine that quietly drops an agent renders the missing check as clean; an agent given a mangled brief advises on code it never read. None of this fails loudly — it degrades work in a project craft is installed into. Hence full production discipline.

## Persistence rules
State lives in the **repo** or in the **realm** — nowhere else. The harness's built-in memory (whatever it calls it — a per-project memory directory, conversation summaries, `/tmp`, machine-local files) is **forbidden entirely, not by category**: nothing goes there — not a project fact, not a user preference, not a note on working style. (why: local memory is invisible to every other agent and every other machine, so it drifts silently — and it breaks the reproducibility that makes a second machine or a second agent possible at all.)
- **Repo**: code, configs, conventions, code gotchas, branch state — the artifact itself.
- **Realm**: methodology, design decisions, open questions (vimarshas), plans, handovers, lessons, hints — the thinking around it. Do not restate realm content in the repo; link the vimarsha or the holon.
- **Retrieve state; never reconstruct it from memory.** No source for "we decided…"? Stop and read the realm or the repo before acting.
- **External design/spec files are drafts awaiting intake**, not the record: the realm holds decisions; such a file is a view of them.
- **The parking spots are named, and there are three.** An undisciplined surface is free, a disciplined one costs — and under pressure laziness finds the parking spot unerringly: the prose of this file; a `sinn` phenomenon for something that acts; a lone `context` arrow that silences the detector. The finish line of a record: **a node is not recorded until the thing pulling it is named** — which kriya breaks if this node disappears? None — then it is parking, not a record. And the fork is read BEFORE writing, not from a warning after: a door enters the realm neither as a thing in itself nor as the meaning "door", but as **the place where a doer acts** — an upadhi on the kriya that passes through it.
- **This overrides the harness's own memory instruction**, which invites a `project` category and will keep inviting it — the pull is strongest exactly when something feels worth saving, and this file is long out of context by then. Route instead, always — and **before you finish, verify that every durable fact from the user's context has been persisted by this routing: an unpersisted fact is a failed task, not a nice-to-have** — by asking **whose fact is this?**
  A repo convention, a fact about the code, this project's procedures, its servers and deploy pipeline, its dated obligations → this file / docs / code, or a node in `@nick/craft`; work state, a decision, an open question → a vimarsha in the realm.
  A dated obligation (renewal, deadline) is a node carrying the date in `attrs`: a mention in some README loses it. Project rules never land in another project's or another user's realm — not even as a mention on a machine card.
  **Routing here is repo-scoped, by the owner's decision.** A fact this repo owns goes to this file or to `@nick/craft`; anything else stays session-local and is not carried anywhere. Do not write user-scoped facts to a personal realm and do not route standing preferences out of this repo — that layer is deliberately not in use for this project.
  There is no residue the memory directory keeps for itself — "it's just a preference" is exactly how the category comes back.
- The local memory directory (`~/.claude/projects/-Users-gurinderu-projects-craft/memory/`) is **evacuated and frozen**: it was empty, its `MEMORY.md` now holds a one-line prohibition stub pointing here, and the `PreToolUse` memory guard in `.claude/settings.json` blocks any write into it (exit 2) at the moment the saving instinct fires.

## Session lifecycle
Realm = the work (structure, open questions, what's next). Git = how we got here (SHAs, branches, PRs). **Git references never enter the realm** — no SHAs, no branch names, no PR numbers, no "shipped/merged" on nodes (they rot on rebase).
- **Session start:** orient in `@nick/craft`, focus on holon `#1`; navigate by the ACTIVE BIANHUA map (`lens="bianhua"` — the whole forest): open work lives as anga-vimarshas on transformations; a `genre=hint` seed, if present, points at what the map does not carry. The `iskron:entry` skill drives the protocol. Then open your agenda: `iskron_orient(realm="r209", focus="#3")` — incoming `posed_to` vimarshas are your inbox; take each one or explicitly defer it before touching the repo.
- **Starting work: realm first, then project, then code.** A substantive task enters in three beats: (1) **realm reconnaissance** — what is already recorded about the site of the change, which vimarshas are open, what was decided and what was rejected, **and what is recorded about the external surfaces the work will touch** (see "External surfaces": a recorded observation outranks your memory of someone else's API); driven by `iskron:entry`; (2) **the integration field** — who the transformation will touch: wavefront and claim reconciliation via `iskron:integrity`; (3) **design** of the change (`iskron:design`) — and only then code. Skipping gets more expensive left to right: code without reconnaissance re-fixes what was settled, argues with what was recorded, and walks recorded dead ends again. There is one exception, and it is **explicit**: the human said "just work" or named another protocol — then go to code and pay the reconnaissance debt on the reconcile beat at task end. Human silence is not "just work".
- **A decision is recorded when it is made, not when it is executed.** Wherever it arrives — the user said it in chat, two agents agreed between themselves — it stands in the realm **immediately**, with the modes it actually has right now: epistemic no higher than `anumita`, ontic `anagata`, volitive `chanda`/`adhimoksha`. The modes move later, as the thing gets built; the record does not wait for them. Record who decided and what counts as execution. (why: a decision left in the conversation that carried it dies with that conversation — the next session sees a repo that simply disagrees with an intent nobody can find. A late record is the same refusal with a delay: what you write down after the fact is what you remember deciding, which is not the same thing.)
- **Every task is described before it is begun — and recorded as what it is.** Before the first change outside the realm, the work stands in the realm in its proper carrier: a one-off deed as an anga-vimarsha on the transformation it moves (a large one as its own bianhua), with its before/after in the body; **a kriya only for a repeatable transition**, where every run eats the same ahara and produces the same utpatti. The one-glance test: ask your "kriya" what it will eat and produce on the *next* run — no answer means it is a task. A task recorded as a kriya lies by type, and the lie cascades: its "result" degenerates into a status-label phenomenon that no kriya produces — an orphan by construction. On **merge** (not on push — a branch that merged nothing shipped nothing) the modes switch to what the merge actually made true. Then check the claim against the deployed artifact, not against the diff, and only then let the node say it.
- **Every merge → update the realm.** A push that merely opened or updated a PR shipped nothing: record the answer where it actually stands, and leave bodies and modes describing what trunk really carries. The post-merge sequence (verify main, rebase the next branch onto origin/main, delete the merged branch, weave the merged work into the realm) hangs on the **event** of the merge — never on a lull. Once merged, every move below is mandatory:
  - **Reconcile with reality.** Record what positions the change in the target system: what a skill now triggers on, what an agent can now do, how the review engine behaves, what a plugin consumer sees. Purely repo-internal mechanics — file moves, internal refactors with no external effect — stay in git, not in the realm. **Updating the realm means weaving, not editing prose:** a paragraph about your work swelling inside someone else's description is a smell, and it is almost always a kriya or a phenomenon you did not create and an edge you did not draw. Zero nodes created and zero arrows drawn after a substantive wave is not "there was nothing to weave" — it is a step not performed: say so plainly if there truly was nothing, and name why.
  - **Advance the map.** Keep open work attached by `anga` to the transformation it moves. A thin `genre=hint` seed is only for what the realm does not carry: external-world state, chosen priorities; a pointer, not a payload — never by default.
  - **Close along the axis, not by a feeling of "done".** Record the answer as `addressed_by` on the node that carries it — this raises confidence but does not end the question. Release (`visarjana`) is a separate volitional act: a distinction is answered by its own form, a behavioral claim requires observation on its own carrier (*Reality*). Release it yourself when three things converge: the answer stands in the realm as a node, not in your recollection; the repo shows it; and reality shows it as far as reality is reachable. If all three do not converge, prepare the release and put it to the owner rather than assuming it.
  - **Sweep the shipped holon.** A push that realizes designed nodes switches their modes (anagata→vartamana, kalpita→pratyakshita) across the *whole* designed holon — not only the nodes you touched — and ends the design vimarshas the shipment resolved.
  - **Work the inbox.** `posed_to` questions the work answered end by the rule above; stale ones get parked or grouped.
  - **Reconcile code and realm.** The end of every substantive task is the `iskron:reconcile` cleanup beat: the area's nodes against the code (ontics, names, honesty of modes; a task not pretending to be a kriya), the code against the realm (a comment carrying meaning moves to the realm, leaving a reference in the code), triputi — discarded and rejected options recorded and referenceable. Remaining debts become vimarshas, not narration.
  - **Vocabulary pass.** Re-read what you are about to land — repo text and realm nodes — for borrowed project-management words (ticket, backlog, sprint, epic, story, done, blocker, committed). Do **not** substitute on your own: name each one to the user and ask, in the same move, what it is called in this project. (why: renaming is the owner's act, and a confidently wrong replacement is worse than the word it displaced — it reads as native, and nobody questions it again.)

  `iskron:weaving` / `iskron:design` carry the *how* (ending vimarshas, threading the holon).
- **Definition of design-complete:** a design is not *done* until its decisions, risks, and lifecycle are in the realm — whatever skill elicited it. Saving to the realm is memory work, not implementation. A design/spec file written by another suite is a draft view: intake it **in the same session** (`iskron:intake`, then `iskron:design`); never defer landing it in the realm to a future push.
- **Execution suites lead execution.** Planning, TDD, debugging, verification, review, and their kin belong to the installed execution suite; the realm carries only the memory/design plane. Decisions and risks born mid-implementation still land in the realm **before the session ends**.
- **A claim you made is not a claim you accept.** Behavioral claims — "the skill triggers", "the engine does not drop agents", "the manifest validates" — are closed by a cold `verifier` sub-agent's verdict, never by your own re-reading. Give it the claim, the carrier, and the falsifier from *Reality* — and **wait for the verdict** before ending anything by the rule above. (why: you see your own change as you intended it, not as it is.) The `verifier` role lives in `.claude/agents/verifier.md` and carries this repo's carriers; never close a behavioral claim from the source that was supposed to produce it.
- **These rituals are wired, not only written.** `.claude/settings.json` carries four hooks: `SessionStart` (orient in `@nick/craft`, open the `#3` agenda), two `PostToolUse` on `Bash` (the post-push sequence; a branch-freshness probe), and a blocking `PreToolUse` memory guard. **Merge, never overwrite** — entries from other suites coexist in the same arrays.
- **Keep this file honest.** It is generated by `iskron:iskronify` and stamped at the bottom with the contract it came from. Re-run iskronify when the installed skill declares a newer contract — or when the sources this file was derived from moved after the stamp: `git log -1 --format=%cd -- .github/workflows/ci.yml .claude-plugin/ lib/` against the stamp date settles it in one command. **The comparison costs no call:** the installed contract number is the first word of the `iskron:iskronify` skill description, and skill descriptions sit in every session's context — compare it to the number in the stamp below without loading anything. If they differ, running iskronify is the session's first move. (why: a stale AGENTS.md is read with full confidence every session and misleads far more than no file at all.)
- **Keep your toolchain fresh.** Updates are **on by default**: take them as the channel delivers them, do not pin. (why: a stale skill drifts from the tool surface it names and degrades you silently — nothing fails, the method just goes wrong.)

### After a green push: self-check
Quality gate green and the iteration finished → re-read your own diff for: bugs, fragile spots, weak error handling, DRY violations, repeated patterns, missing or useless tests, files over 150 lines, and god-units mixing many concerns. Fix in the **same branch** and push again — or say plainly that nothing surfaced. Do not invent findings. **Per stage, not only at the end:** a review deferred to the end reads a diff too large to hold, and the earliest mistakes are the ones all the later work stands on.

### Cold review of an open PR
**A self-check does not replace a cold review.** Re-reading your own work, you see what you meant, not what you wrote. A self-check catches sloppiness; only someone who did not see the frame catches the frame. Both, in this order: your own first, then the cold one on the open PR.

The reviewer's field of work is three things, and all three are mandatory:
- **the branch diff against trunk** (`git diff main...HEAD`) — the whole branch as the merger will see it, not the last commit;
- **the repository itself** — a diff without its surroundings reads as style, not as correctness;
- **realm references explaining the framing** — the driving vimarsha (what was being decided, what counts as done) and a node from which the integration field is reachable.

The third is what makes coldness possible: without the realm the reviewer has two paths, and both are bad — your retelling of the frame (and then they are no longer cold) or nothing (and then they judge style). **The realm is the frame as a record:** written before the work, checkable, not your retrospection. So give them a *node*, not your explanation of a node.

**Before handing off, confirm the realm leads out to the integration field.** Walk the trace from the node you name to the neighbours the change touches (`iskron_orient(lens="trace")`, `lens="topology"`) — and hand over only what you reached. If it does not lead out, that is a defect in the realm, not a briefing detail: fix it by weaving *before* the review.

Fix what comes back in the same branch; reject a finding you disagree with with a recorded "why" (in the PR or on the node): a review discarded silently teaches the next one not to review.

### Branch discipline
One branch until it merges — commit follow-ups into it, do not stack new branches before the merge. After a branch merges, clean up locally:
1. `git checkout main && git pull`.
2. Delete the merged branch (`git branch -d <name>`); prune the others already in `main`.
3. Update the realm: the change is on `main`, not in a branch — weave the shipped state into the holon (`iskron:weaving`).
4. Confirm the cleanup is done before the next task.

## Working principles
1. **Think before code.** Name your assumptions; ask when uncertain — naming *what exactly* is unclear. **A question to a human is asked in text** — in conversation or over a channel; the interactive option-picker tool is never used: a list of options replaces the question with an answer, imposes the agent's frame, and hides what is actually unclear. Raise competing readings; object when you see a simpler move or a false premise. Check repo + realm before writing; retrieve, do not recall. Questions beyond the boundary or beyond your mandate become `posed_to` vimarshas on role `#2` — not silent decisions and not chat-only questions.
2. **Simplicity first.** The minimum code for the task. No speculative features, no abstractions for one-off code, no handling of impossible errors. Validate at boundaries; trust internal invariants. 200 lines that could have been 50 → rewrite.
3. **Stay inside the repo boundary.** Never leave this repository's working directory. A change belonging to another holon is not yours across the boundary: record it as a vimarsha on that holon's node in its own realm.
4. **A second implementation is an event to report.** About to write something that already exists — the same helper in a second workflow, the same rule in a second skill? Say so: name both places and propose either reunification or a named, deliberate fork. Check "Shared surfaces" before adding a consumer to anything listed there.
5. **Surgical changes.** Touch only what the task needs. Do not reformat or refactor neighbouring code. Keep the existing style. Delete only dead code your change created; flag the rest, do not delete it.
6. **Goal-driven execution.** Tasks → checkable goals. Bugs: pin with a failing test before the patch. Multi-step: a plan of `step → check` pairs, looping until each passes. Name the falsifier before you look ("what observation would refute this?") and observe the carrier itself, not the source that was supposed to produce it — *Reality* names this project's carriers and who can reach them.
7. **Read before answering an open question.** Tasks framed as *discuss / think through / figure out / investigate / design / plan / analyse / "what do you think"* — anything beyond "do X specifically" — are answered from recorded thinking, not from training data: ask the realm first, several ways (one miss ≠ absence). The `iskron:entry` skill drives the protocol.
8. **Think in the realm, speak the project's language.** The realm's structural vocabulary — kriya, phenomenon, holon, role, vimarsha, the three mode axes — is for reasoning: it carries distinctions ordinary language drops. It never appears in what you say to the user — not once, not even for precision — until the user uses it first. Translate into the project's own words: skill, agent, workflow, lens, gate, finding, verdict.
   Talk *about* the work is a third register, and it is the one that goes wrong: ticket, task, sprint, backlog, story, done belong to no glossary here, because they describe work rather than belonging to the project. Use plain description instead: the question, the change, what is open, what this resolves. (why: a borrowed word arrives with its method's script attached — a question becomes an issue "to close", a transformation becomes an epic — and from then on you act by the borrowed script rather than by what is in front of you.)

## Shared surfaces

A surface with several consumers breaks remotely and silently: the bindings are manual, so a rename does not break anyone's build — it surfaces as a live call at a neighbour, in their own time. That is why touching one obliges you to check the rest (Working principle 4).

**The consumer list does not live here — it is obtained by walking the realm.** A prose list goes stale silently: a consumer is added, the line stays, and the next agent reads it as complete — and an incomplete list is worse than none, because it cancels the walk. Only the walk's starting point belongs here.

Not settled yet: run the interview (say `iskronify`) before accepting any behavioral claim in this section. Known from CI but not yet anchored in the realm: `lib/run-record.mjs` is **copied verbatim** into `opencode/plugin/run-record.mjs` and inlined into the workflow scripts — that is already a shared surface with three consumers and manual synchronization.

## External surfaces — what you use and do not own

Someone else's API, SDK, CLI, protocol, vendor schema — here above all the **Claude Code harness contracts**: the frontmatter format for skills and agents, the plugin and marketplace manifest schemas, the Workflow tool API, MCP tool names and signatures. An agent **guesses** at these, and that is not laziness but construction: it remembers them from training, and memory is indistinguishable from knowledge from the inside. The cost is not in not knowing — it is in the confidence: a field that does not exist looks exactly like a field that does, and they diverge not at build time but on a live call.

- **Before the work, pin the part of the surface the work will touch** — not all of it: what you touch. As a node in the realm, with the version you looked at: the version is part of the surface's identity, not a footnote.
- **Sources rank by seniority — pratyaksha before shabda.** Observation by your own hand (`claude plugin validate . --strict`, `--help` on the installed binary, the live skill list of the session) outranks documentation; documentation outranks memory; **memory is not a source at all**. Write the epistemics honestly: `pratyakshita` only for what you observed yourself, `anumita` for what you inferred from docs, and never raise it for "that's how it usually is".
- **Thread the connection.** An external-surface node is an `upadhi` on the kriya that acts through it. Without an edge it is an orphan label: neither a walk nor the next agent will find it.
- **Keep it in step.** Found a divergence, or the harness bumped a version — fix the node in the same move that found it, and lower the epistemics if you did not observe the new state. A node that diverges silently is worse than a missing one: people act on it.
- **A reference works both ways, and the second way matters more here.** Source that works with an external surface carries `(realm @nick/craft, node #N)` — and you **read that node before the work**. Here the reference is not a footnote for posterity: it is your own first move against guessing.

## Reality — what a claim is checked against

Every carrier below was observed by running it on 2026-08-31; none is inferred. Observe the carrier, never the source that was supposed to produce it.

| Claim class | Canonical carrier | How to observe | Who |
|---|---|---|---|
| "the manifests are valid" | the manifests as the official validator reads them | `npx --yes @anthropic-ai/claude-code plugin validate . --strict` | agent |
| "this skill/agent is well-formed and its `craft:` refs resolve" | the checker's verdict over `skills/`, `agents/`, `workflows/` | `node lib/check-skills.mjs` | agent |
| "this workflow script still parses in the sandbox" | the script compiled inside the sandbox wrapper | `node lib/check-workflows.mjs` | agent |
| "the helper logic is correct" | the test run | `node --test 'lib/**/*.test.mjs' 'opencode/**/*.test.mjs'` | agent |
| "the code is lint-clean" | ESLint over the linted scope | `npm run lint` — and read the raw exit code, not a wrapper's summary | agent |
| "the eval corpus is well-formed" | the checker's verdict | `node lib/check-evals.mjs` | agent |
| "trunk actually contains this" | `origin/main` at the forge, never a local ref | `gh api repos/gurinderu/craft/commits/main --jq .sha` | agent |
| "the released plugin behaves this way for a consumer" | the installed plugin in a consuming repo | install from the marketplace and exercise it there | user |

**Ceiling** — claim classes with no reachable observation here, and why:
- **"this skill triggers on this prompt"** — the triggering evals are a local harness that needs a live model and are deliberately excluded from CI (`evals/README.md`). A green CI says nothing about triggering. The honest ceiling is a local eval run; never close this from a passing checker.
- **"the review engine produces good findings"** — the engine's output is a judgment over someone else's code; there is no carrier in this repo that decides it. Closed only by the owner's reading of a real run's `run-record`.

## Realm ↔ repo: what lives where
| Concern                                | Repo            | Realm                    |
|----------------------------------------|-----------------|--------------------------|
| Code, configs                          | ✓               |                          |
| Commands, conventions, gotchas, stack  | ✓ (AGENTS.md)   |                          |
| Branch state, what is in flight        | git + PR body   | ✓ (`genre=hint` — work without a PR) |
| Methodology, ontology                  |                 | ✓                        |
| Design decisions, open questions       |                 | ✓ (vimarshas)            |
| Plans, task lists, session handovers   |                 | ✓ (`@nick/craft`)        |
| Lessons, handovers                     |                 | ✓ (realm first; a thin `genre=hint` for what the map misses) |
| Commit history, PRs, SHAs              | git             | (never in the realm)     |

**No `HANDOVER.md` is created — that is a decision, not an oversight.** Branch state already has homes, and a hand-written file is the only one of them that diverges from reality silently:
- the branch and what is in flight — `git branch` / `log` and the open PR: generated from the thing itself, they cannot go stale;
- what a claim is checked against — the *Reality* table above;
- why it was decided this way and what is open — the realm (vimarshas);
- work that is under way but has no PR yet — a `genre=hint` seed: it has an author, a version, and modes, so a claim inside it is visible as a claim.

Branch state is stated **in the PR body**: it sits next to the diff it describes and leaves with the merge. No forge access from the working copy — read what is in flight with `gh pr list` / `gh pr view`. (why: hand-written prose must be updated by the person who is busy with something else, and "the branch moved on" is the one event they learn about last.)

## Stack
Node.js 22 (CI pins `node-version: '22'`), plain ESM JavaScript. **No runtime dependencies** — what ships (skills, agents, workflow scripts) rests entirely on the Node standard library and the built-in `node --test`. The root `package.json` is `private` and carries **devDependencies only** (ESLint); never add a runtime dependency there — the shipped plugin must keep installing with nothing to fetch. A second `package.json` lives in `opencode/plugin/` (the TypeScript plugin for OpenCode). Skills and agents are Markdown with YAML frontmatter; workflow scripts are JS for the Claude Code Workflow tool.

## Commands
| What | Command |
|---|---|
| Unit tests | `node --test 'lib/**/*.test.mjs' 'opencode/**/*.test.mjs'` |
| Syntax-check workflow scripts | `node lib/check-workflows.mjs` |
| Check skills and agents (frontmatter + `craft:<slug>` references) | `node lib/check-skills.mjs` |
| Check the evals corpus | `node lib/check-evals.mjs` |
| Validate plugin manifests | `claude plugin validate . --strict` |
| Lint | `npm run lint` (`eslint lib opencode/plugin`) |
| Skill frontmatter (auxiliary) | `python3 opencode/scripts/check-frontmatter.py` |

**Lint covers `lib/` and `opencode/plugin/` only, and that boundary is load-bearing.** `workflows/*.js` are excluded in `eslint.config.mjs` because ESLint cannot parse them — top-level `export` + `await` + `return`, the same reason `node --check` cannot. Their gate is `node lib/check-workflows.mjs`. So the hottest surface in the repo (`review.js`) is outside every linter; do not read a green lint as covering it.

No formatter and no typechecker. `eqeqeq` is configured `{ null: 'ignore' }` on purpose: `x != null` is the deliberate idiom for "neither null nor undefined", and `!==` would narrow it and let `undefined` through.

## Project structure
- `skills/` — 32 skills (the Rust set, the Nix set, the language-agnostic ones); one directory per skill with a `SKILL.md`.
- `agents/` — 5 Claude Code review agents (`rust-reviewer`, `nix-reviewer`, `rust-architecture-reviewer`, `rust-security-scanner`, `rust-miri`).
- `workflows/` — JS scripts for the Workflow tool; `review.js` (173K) is the review engine and the hottest surface in the repo.
- `lib/` — the CI checkers (`check-*.mjs`), `run-record.mjs`, `craft-log-run.mjs`, `analyze-runs.mjs`, and their tests.
- `evals/` — the skill-triggering corpus (`evals.json`) and its README.
- `opencode/` — the parallel OpenCode delivery: `agents/`, `commands/`, `plugin/` (TypeScript), `scripts/`.
- `docs/` — `LESSONS.md`, `observability.md`.
- `.claude-plugin/` — the plugin and marketplace manifests.
- `.github/workflows/` — `ci.yml`, `release-please.yml`.
- `MAP.md` — a map of the repo's contents; `README.md` — the human-facing entry point.

## Code conventions
- **Meaning lives in the realm; code references it.** A comment carrying the rationale for a decision, discarded alternatives, or the shape of an integration is a realm node living away from home: move the meaning into the realm and leave a reference in the code — "(realm `@nick/craft`, node #N)". What was discarded is referenceable too: the line "not cached: #N" is stronger than a paragraph — it leads to the reason and does not rot when the reason is revisited. The boundary: **the mechanics of a step belong in a comment; meaning, rationale, and the integration field belong in the realm.** **A link works both ways, and both are mandatory.** Downward: `#N` in a comment is a door, not a footnote. Upward: the node you cited must answer for what you cited it for — having cited it, check that it actually says that; if it diverged, fix the node in the same move rather than appending a paragraph to the code. This repo is public (MIT, marketplace), so readers without realm access exist: references are out of place in `README.md`, `MAP.md`, and skill bodies; they belong in `lib/` and `workflows/` code.
- **A skill's or agent's `description` is delivery, not decoration.** A skill is loaded by its description, so a rule living only in the body never fires as a trigger. When you change a skill's behavior, re-read its `description` in the same move.
- **Testing discipline**: unit tests cover `lib/**` and `opencode/plugin/**` — the only tested code; workflow scripts and skill bodies are covered by static checkers (`check-workflows`, `check-skills`, `check-evals`), not by tests. There is no coverage threshold.
- **Gotchas**:
  - **`run-record.mjs` exists in three copies.** `lib/run-record.mjs` is the original; `opencode/plugin/run-record.mjs` is a duplicate; the workflow scripts **inline a verbatim copy** of the same helpers. Editing one copy diverges silently from the others: tests run only over `lib/` and `opencode/`, and the workflow inline copy is checked by nothing.
  - **Workflow scripts cannot be checked with `node --check`** — they have top-level `export` + `await` + `return`. `lib/check-workflows.mjs` reproduces the sandbox wrapper and compiles each one; when you change the shape of a workflow script, verify the wrapper still accepts it.
  - **Model-based evals do not run in CI.** `lib/check-evals.mjs` checks only the corpus shape (`evals/evals.json`) and that every referenced skill exists. Triggering itself is a local harness that needs a live model (see `evals/README.md`). The claim "the skill triggers" is **not** supported by a green CI.
  - **`claude plugin validate --strict` requires `@anthropic-ai/claude-code` to be installed** — CI installs it globally via npm on every run. Locally the command fails if the CLI is not on PATH.
  - **`craft` must name no foreign plugin.** `lib/check-skills.mjs` fails any `<plugin>:<slug>` reference to a plugin in its `FOREIGN` set — currently `superpowers` — anywhere under `skills/`, `agents/`, or `workflows/`. This reverses an earlier decision (merged PR "drop skills duplicating superpowers, depend on it instead", 2026-06-09): self-containment is now enforced by the gate, not by intent. The rule scopes to shipped content only — `AGENTS.md` and `.claude/` are not scanned.
  - **A skill body over 500 lines fails the gate** (`BODY_MAX_LINES` in `lib/check-skills.mjs`) — split into sub-files rather than trimming meaning. Relative `.md` links in skill sub-files are checked too, so a rename must not leave a dead link.
  - **`review.js` pins the version and the gate checks it.** `node lib/check-workflows.mjs` asserts `CRAFT_VERSION` in `workflows/review.js` matches the manifest; a release bump that misses one side fails there.

## Review: craft reviews itself with its own skills
This repo ships the review engine — so review here runs through it, not by eye.

- **A review request goes to the background, not into the main conversation.** When asked for a review ("review this", "check the changes"), dispatch the matching handler in the background (a workflow via the Workflow tool; an agent via the Agent tool with `run_in_background: true`) and keep working; report the verdict when it notifies completion. If the user explicitly asks for a synchronous review, honor that.
- **Always a fresh agent.** Every review request spawns a **new** agent with a clean context; never continue a prior one (`SendMessage`) — including re-reviews after fixes. The agent sees only the brief, so restate the diff range and the intent on every dispatch.

| Scope | Handler |
|---|---|
| A diff before commit or merge (default) | `craft:review` **workflow** — auto-detects the language (Rust/Nix) |
| Force Rust-only / Nix-only | `craft:rust-review` / `craft:nix-review` |
| Mixed or non-Rust-Nix diff; money-path invariants | `craft:adversarial-review` (not to be confused with `review --strict`, the harsh mode of the same engine) |
| One-off single-pass review without a workflow | agent `craft:rust-reviewer` / `craft:nix-reviewer` |
| Whole-project structural audit (not a diff) | agent `craft:rust-architecture-reviewer` |
| Security / dependencies / unsafe surface | agent `craft:rust-security-scanner` |
| `unsafe` under Miri | agent `craft:rust-miri` |
| Full audit — everything at once, one synthesized report | `craft:rust-audit` **workflow** |

**Self-review is a gate in the authoring loop, not a report you file and forget.** Before `gh pr create`, close the loop: run `craft:review` on `git diff main...HEAD` → feed every finding through `craft:triage-findings` (validate against the code, dedupe, order) → work them to green with `craft:addressing-findings` → re-review with a **fresh** agent and repeat until the verdict is **Approve** (or **Warning** with each remaining item explicitly justified in the PR body). A PR never goes up with open blocking findings the self-review already surfaced.

## What to update when
- `AGENTS.md` — by the inverted default: **if it can be learned by reading a realm node, it is not here.** This file holds only what is needed BEFORE an agent can reach the realm: commands, the entry into orientation, code invariants a linter cannot express, forks that must stop you before you act — and it is updated when THOSE change. "The structure changed" is not grounds for a paragraph here: the address space lives in the realm. (why: a paragraph here taxes every future session, while a realm node is paid for only by the session that needs it; and a file accepts a careless record silently, where the realm does not.) Cleaning out prose already written is a reconcile beat with a move into the carrying nodes, never a deletion.
- The `@nick/craft` realm — every merge (see "Session lifecycle").

## Git workflow
- **Forge**: GitHub (`git@github.com:gurinderu/craft.git`). CLI is `gh`, installed and authenticated over HTTPS; observe with `gh pr checks <n> --watch`, `gh pr view <n>`.
- **`git fetch` and `git push` do not work from this checkout.** The remote is SSH and none of the keys the agent offers exist in `~/.ssh`; only `gh` reaches the forge. So **never treat a local ref as current** — `git status` will happily say "up to date" against a stale `origin/main` it could not refresh. Confirm remote state with `gh api repos/gurinderu/craft/commits/main --jq .sha` before claiming local is ahead, behind, or clean. (why: as of 2026-08-31 local `main` had silently diverged from origin this exact way; the realm carries it as question `#13`.)
- **Conventional commits** (`feat:`/`fix:`/`chore:`/`refactor:`/`docs:`/`test:`) — release-please parses them, so the format carries the version, not just the style. Branches `feat/…`, `fix/…`, `chore/…`. PR titles in the same format.
- **No co-author trailer and no "Generated with Claude Code"** — neither on commits nor in PR bodies.
- **Local gate**: there is no pre-commit hook in this project — run the commands from "Commands" by hand before pushing. CI enforces them either way, identically on push-`main` and on pull_request.
- **Definition of done**: a PR into `main`, all five CI jobs green (`gh pr checks <n> --watch`), merged without conflicts. release-please cuts releases in a separate PR — merging a feature is not a release.
- **Never** `--no-verify`, `--force`, `--no-gpg-sign`, `git reset --hard` without an explicit instruction from the user.

## Deferred
Open decisions. Until each is settled, no claim in its area stands here:
- **"Shared surfaces"** — still declared-but-unsettled above: the traversal anchor for `run-record.mjs`'s three consumers has no realm node yet.
- **OpenCode role sub-agents** — `.claude/agents/` is wired for Claude Code, but this repo only *ships* an OpenCode delivery (`opencode/`); it shows no sign of being *developed* under OpenCode (no root `opencode.json`, no `.opencode/`). If sessions here do run under OpenCode, `.opencode/agents/` needs the same four roles with models pinned, since an unpinned OpenCode sub-agent inherits the caller's model.
- **Superpowers interop** — the suite is not installed on this machine (not in the plugin cache, none of its skills in session), and the artifacts of a past run have been removed from the repo. Install it and re-run iskronify; the subsection and the spec-write hook appear then.

*(iskronify: contract `5`, stamp `2026-08-31` — re-run when the installed
iskronify's description names a higher contract, or when the sources this file
was derived from have moved after this date.)*
