# `craft`
A Claude Code plugin: an opinionated set of engineering skills (a broad Rust set, a Nix set, language-agnostic specs/debugging/refactoring/onboarding), review agents, and a review workflow engine — shipped through its own marketplace and run inside other people's repositories.

## Cover
| Slot | Value | Source |
|---|---|---|
| Nature | `production` — no relaxations | agreed: owner |
| Realm | `@nick/craft` (`r209`) — every session starts here | derived |
| Focus holon | `#1` «Контур craft» | derived |
| Repository | `github.com/gurinderu/craft` — attribute `repository` on holon `#1`, from `origin` | derived |
| Agent role | `#3` «Инженер craft» — adhikarin, steward of the focus holon; inbox `iskron_orient(realm="r209", focus="#3")` | derived |
| Owner role | `#2` «Владелец craft» — svatantra; address for `posed_to` beyond the mandate | derived |
| Stack | Node.js 22 (CI pin), plain ESM JavaScript, no runtime dependencies; skills and agents are Markdown with YAML frontmatter | derived |
| Gate | `<not agreed — case №1>` — there is no single gate call yet; the steps are listed under "Commands" | |
| Consumers | anyone who installs craft from `.claude-plugin/marketplace.json`; they learn of breakage only by its effects — a skill that never triggers, a review that silently drops a check, an agent advising on code it never read | agreed: owner |
| Cost of breakage | external and silent: craft runs in repositories it never sees, and none of its failures fail loudly — a degraded check reads as a clean one | agreed: owner |
| Reality | `REALITY.md` at the root — read on occasion (section "Reality" below) | derived |
| Layout | one `AGENTS.md`; code map — "Project structure" below plus `MAP.md`; gotchas live in the realm as rule nodes on the steps they constrain | derived |
| Cross-project memory | repo-scoped only, by the owner's decision: facts this repo owns go here or to `@nick/craft`; nothing is routed to a personal realm; never the memory directory | agreed: owner — diverges from the skill default (personal realm), raised in case №1 |
| Feedback reflection | `<not agreed — case №1>` | |
| Workflow-suite interop | none — no coercive workflow suite is installed (superpowers absent from the plugin cache) | derived |
| Agreement | case №1 on holon `#1` «Выравнивание craft под контракт 18» — open slots are its `slot: …` lines; a new question about the cover is a word in that case, not a node | |

## Persistence rules
State lives in the **repo** or in the **realm** — nowhere else. The harness's built-in memory (memory directory, conversation summaries, `/tmp`, machine-local files) is **forbidden entirely, not by category**. The work ledger is a case's lines; while there is no case (not opened, or the case surface is unreachable) — one file in the session's temporary directory: a reason to open a case; it dies with the session and moves nowhere — the only exception to the ban.
- **Repo**: code, configs, rituals (how to act here), branch state.
- **Realm**: decisions, substantive questions (vimarshas), plans (the transformation map), lessons, gotchas. Do not restate the realm in the repo — link it.
- **Case** (a log on a realm node): one-off tasks, one-off questions, work progress, shift handover — never rewritten into nodes.
- **Retrieve state, do not recall it.** No source for "we decided…" — read the realm or the repo before acting.
- **External design/spec files are drafts awaiting intake**: the realm holds the decisions.
- **A node is not recorded until the thing pulling it is named** — which kriya breaks if it disappears? Three hiding places: the prose of this file; a `sinn` phenomenon for something that acts; a lone `context` arrow. A door enters the realm as the place where a doer acts — an upadhi on the kriya.
- **Whose fact is this?** — ask always, over the harness's memory instruction; before finishing, check that every durable fact from the conversation is persisted. A ritual, command or procedure of this repo → this file; a fact about the code, servers, deploys, dated obligations (date in the node's `attrs`) → `@nick/craft`; the meaning of code (decisions, rationale, links) → the realm always; file navigation → per the "Layout" slot; a decision → a node at once; a substantive question or obligation → a vimarsha; a one-off task and progress → the case; work state → node modes. Routing is repo-scoped (cover, "Cross-project memory"): anything this repo does not own stays session-local and is carried nowhere. Project rules never land in another project's realm.
- **Agent behaviour is configured only by committed working-tree files (AGENTS.md, the hooks file) and the project realm** — never a global instructions file (`~/.claude/CLAUDE.md`, `~/.config/opencode/AGENTS.md`…), harness memory, or user hooks. Installing a delivery (bridge, plugin) is delivery, not configuration.
- The memory directory is **evacuated and frozen**: the `PreToolUse` memory guard in `.claude/settings.json` blocks writes into `~/.claude/projects/*/memory/` (exit 2). Two arms: `Write|Edit|MultiEdit` tests `file_path`; `Bash` tests the command for a write shape aimed at that path (`>`/`>>`, heredoc, `tee`/`cp`/`mv`/`rm`/`touch`/`install`/`mkdir`). Reads are not blocked, nor is a write the regex cannot see (an editor, a path built at runtime) — the guard catches the reflex; it is not a sandbox.

## Session lifecycle
One line per rule; the full norm of case work and the ledger is in the `iskron` skill.
- **The realm is the work, git is how we got here.** SHAs, branches, PR numbers, "merged" never enter the realm (bodies, names, attributes); provenance goes in a write's `reasoning`. In a case log they are written freely.
- **Session start** — the "Start" section of the `iskron` door, before acting; it ends in readiness (realm and role named, greeting delivered), not in reading. Standing only on watch (the word «вахта», `start`, a seat address from the window, a frame), with one `iskron_stand`. `start <realm> <role> <case №N>` enters that case, and the first word restates the brief. A subagent has its own satellite bridge (`iskron_stand` with `satellite_of`, `join`, `leave` — on it); a launch on the launcher's bridge is not allowed — a subagent without its own bridge does not write to the realm and says so on the first line of its result. Addresses come from the cover; the owner is its role's seq, not `me`.
- **Starting work: realm, then project, then code.** (1) realm reconnaissance (`entry`): what is recorded about the site of the change, open vimarshas, what was decided and rejected, what is recorded about the external surfaces; (2) the integration field (`integrity`, section below); (3) design (`design`), then code. Skip only on an explicit "just work" or another named protocol — the reconnaissance debt goes to reconcile; human silence is not permission. Work that bypasses the realm is an agent's worst failure.
- **A decision goes into the realm the moment it is made**, wherever it came from (chat, socket, agents agreeing): epistemic no higher than `anumita`, ontic `anagata`, volitive `chanda`/`adhimoksha`; who decided and what counts as execution. A changed situation — the same, at once.
- **A task is described before it begins — as what it is.** A one-off — a word in a case: the brief, the restatement, a `поручение: …` line at the one who set it, closed by the doer under the same key by outcome; it came without a case — open one (`open_room` on the subject's node, or `iskron_case(action="talk", about=<subject>)`) before the first change outside. Into the realm go the transitions it changes (in design modes; a large one as a transformation) and decisions. A vimarsha is only a substantive question or an obligation; a kriya only a repeatable transition: ask what it will eat and produce on the next run — no answer means it is a task.
- **Work runs through a case.** Ledger line: one key per topic; `done` — one action; `note` — what is wrong, with `ok` only the observation ceiling; the unobserved is not `ok`; work that changed what the realm describes, on an event (merge, rollout, decision, case closure) — `partial` "realm to catch up — on the weaver", and the same key `ok` with three parts: landed, moved, released, each at least "zero, because…"; done and open diverge — the done part `ok` by topic, the remainder under its own key `partial` "on whom, waiting for what". Waiting inside a case — `partial`; between cases and on substance — a `posed_to` vimarsha. A word to an agent — in the case; a channel only to a human without a seat in the case. Declining an assignment — a word and a `bad` line "declined: reason" under the same key; withdrawing — the withdrawer's line; declining a vimarsha — editing it. Leaving or handing over a shift — close or hand over open lines; handover is a transformation seed and a word in the case, leading by agreement (`architect` skill).
- **Merge → realm.** A push that opened or updated a PR shipped nothing. The sequence hangs on the merge event, not on a lull. Every act is mandatory — except for work by reference from an agent (a brief by references, a report in a case): there weaving, closing along the axis and reconciling are the setter's, and the doer's are the transformation seed and the delivery modes (`vahta` skill):
  - **Weave** (`weaving`): what shipped — into the target system (architecture, API, delivery, experience, integration) as nodes and edges, not a paragraph; repo mechanics stay in git. Zero nodes and arrows after a substantive wave — say plainly why.
  - **Advance the map**: open work — `anga` to the transformation; one `genre=hint` seed per transformation — only what matters after the session; live cases are lines.
  - **Switch modes** (`anagata→vartamana`, `kalpita→pratyakshita`) across the whole designed holon — after evidence on the carrier (`REALITY.md`, **reality-audit**).
  - **Close along the axis** (`inquiry`): `addressed_by` to the carrying node; `visarjana` when the answer stands as a node, the repo shows it and reality shows it as far as reachable (where not — the user's word); otherwise put it to the owner; other ends — keep, supersede, crystallise. In the same move — the `posed_to` inbox (do not judge the rest by age; a change at the anchor wakes them), case lines `ok` by what was observed, `propose_close` with evidence.
  - **Reconcile** (`reconcile`): nodes against code, code against the realm, discarded options recorded and referenceable; the remainder as vimarshas.
  - **Vocabulary pass**: borrowed words (ticket, backlog, sprint, epic, story, done, blocker, committed) in the text and nodes you land — name each to the human and ask what it is called in this project; never substitute on your own.
- **A design is not ready until its decisions, risks and lifecycle are in the realm** — whatever skill elicited it; a design/spec file from another suite is intaken in the same session. Without the owner: decisions and risks now, the transformation with a telos for confirmation.
- **Execution suites lead execution** (planning, TDD, debugging, review); the realm carries memory and design. Decisions and risks born in execution go into the realm before the session ends.
- **A claim you made is not a claim you accept.** A behavioural claim is closed by a cold `verifier`: the brief is the claim, the carrier and the falsifier from `REALITY.md`; wait for the verdict. No role available — observe the carrier yourself, never the source.
- **Hook merge**: entries from different suites coexist in the hooks file — add alongside, never overwrite someone else's.
- Start, push, merge and memory-write hooks are wired in `.claude/settings.json`, one line each, plus a pre-push branch-freshness probe.
- **Keep this file honest.** The contract number is the first word of the `iskronify` skill description, present in every session's context: compare it with the stamp below without loading anything. Higher than the stamp, or the sources moved after its date (`git log -1 --format=%cd -- .github/workflows/ci.yml .claude-plugin/ lib/ package.json`) — propose an `iskronify` run as the first move (launching is the human's or the case's word; silence — propose again; on watch without a window, having asked colleagues, the run is executed by the "Who runs it" rule of `iskronify`: the `designer` role, or yourself without subagents or the role). A line of this file diverges from the skill — say so aloud (in a case to the setter, otherwise to the human): the stamp is lower — the skill is right; equal — a template defect, feedback to the skill delivery's steward (`feedback` skill).
- **Keep the toolchain fresh**: updates are on by default — take them as the channel delivers them. A channel without auto-update (an unpacked copy) — check the version before the session, or move.

### Stage self-check
Gate green and a coherent stage finished (a PR opened or updated, or you are about to touch nodes beyond the initial ones) — re-read the branch diff against trunk: bugs, fragile spots, weak error handling, DRY/SOLID violations, missing or useless tests, files over 150 lines, god-units. Fix in the same branch and push, or say plainly that nothing surfaced; do not invent findings. Per stage, not only at the end.

### Cold review of the stage
- **A self-check does not replace a cold review** — both, in this order: you see your own work as you intended it.
- After the self-check, before `gh pr create` — review by the `reviewer` role, **in a separate worktree** (Claude Code: `isolation`). The harness cannot — say that there was no cold review. Only the push has a hook; a stage without a push is yours to hold.
- **The cold review comes before the PR, not after** (realm `@nick/craft`, #127): an open PR is an invitation to merge, and a review that lands after the merge has lost.
- The reviewer's field: the whole branch diff against trunk; the repository itself; the focus holon and its steward role; references to the realm nodes the diff touches (not a retelling). It runs `integrity` read-only and returns, with findings, an integration report: affected nodes, relays, open questions, neighbour readiness, whom to wake (`standing`); unknown — `unknown`.
- `NEEDS_CONTEXT` is a realm defect: design further, weave, pose vimarshas, review again.
- A finding you disagree with is rejected with a recorded "why" (in the PR or on the node).
- A sub-agent helping a case is launched with the line `start <realm> <role> <case №N>` (`vahta` skill).

### Branch discipline
One branch until it merges — follow-ups go into it. After a merge: `git checkout main && git pull`; delete the merged branch (`git branch -d`) and others already in `main`; weave what shipped into the realm; the next branch from a fresh `origin/main`; confirm the cleanup before the next task.

## Working principles
1. **Think before code.** Name your assumptions; when unsure, ask *what exactly* is unclear. **A question to a human is asked in text** (conversation, case, or — while there is no seat in a case — their standing bridge); the option-picker tool never: it replaces the question with an answer. Object when you see a simpler move or a false premise. Touch the live system before trusting a type, a name, a doc. Beyond the mandate — a `posed_to` vimarsha to the owner role.
2. **Simplicity first.** The minimum for the task; no speculative features, abstractions for one-offs, handling of the impossible. Validate at boundaries.
3. **Stay inside the repo boundary.** Edits only in the working directory; outside it — reading carriers, the session's temporary directory and the delivery's home. Another holon — a vimarsha on its node (`anga` to the transformation) and a word to its steward in a case (`iskron_case(action="talk", about=<subject>)`).
4. **A second implementation is an event to report.** Derive both places through `integrity`, name them to the human, propose reunification or a named fork; a new consumer gets its edges in the same move.
5. **Surgical changes.** Touch what the task needs; do not reformat or refactor neighbouring code; keep the style; the linter is authoritative; delete only what your change made dead — flag the rest, do not delete it.
6. **Goal-driven execution.** A bug — a failing test before the patch. Multi-step — `step → check` pairs. Runtime — in the real environment. The falsifier before you look; observe the carrier (`REALITY.md`), not the source.
7. **Read before answering an open question.** Discuss, think through, design, "what do you think" — from what is recorded, not from training data: the realm several ways (`entry` skill). A search hit is a lead, not data: structure and links only through `iskron_look`, `iskron_orient` and its lenses; hand wide reconnaissance to a subagent.
8. **Think in the realm, speak the project's language.** The realm's vocabulary (kriya, phenomenon, holon, role, vimarsha, modes) is for reasoning; to the human — the project's words (skill, agent, workflow, lens, gate, finding, verdict) until they use it first. About the work — no ticket, task, sprint, backlog, story, done: the question, the change, what is open, what this resolves.

## Integration field — from the realm only
- The root of the walk is the focus holon `#1` and the steward role `#3`. Do not keep a list of shared surfaces or consumers here and do not ask the human for one — someone else's thing the realm does not model belongs under "External surfaces".
- For each change name the nodes whose embodiment is in the diff and run `integrity`: a phenomenon — `iskron_orient(lens="trace")` both ways; a kriya — the `next` thread and the `ahara`/`utpatti`/`upadhi` relays; crossing into another holon — to its steward role.
- A dependency the walk did not find is a model defect: design (`design`), weave (`weaving`), waiting — a `posed_to` vimarsha and a word in the case. A public handle with no trace in the realm is either unneeded or a realm debt. A new consumer is in when the code and the edges appeared in one move.

## External surfaces — what you use and do not own
Someone else's API, SDK, CLI, protocol, schema — here above all the Claude Code harness contracts (skill and agent frontmatter, plugin and marketplace manifest schemas, the Workflow tool API, MCP tool names): memory of them is indistinguishable from knowledge, and a wrong name diverges on a live call.
- **Before the work, pin the part of the surface you touch** as a realm node, with the version.
- **Pratyaksha before shabda**: observation by your own hand (a call, `--help`, `claude plugin validate . --strict`, the installed package's types) outranks docs, docs outrank memory, memory is not a source. `pratyakshita` only for what you observed.
- **Thread the link**: the surface node is an `upadhi` (or `ahara`/`utpatti`) on the kriya that acts through it.
- **Keep it in step**: a divergence or a new version — fix the node in the same move; lower the epistemics if you did not observe it.
- Source that works with a surface carries `(realm @nick/craft, node #N)` — and you read that node before the work.

## Reality — what a claim is checked against
The carrier table is in `REALITY.md` at the root, read on occasion. Before saying a behaviour "works", switching a mode, or closing a question — read the row of your claim class and observe its carrier; the row goes whole into the `verifier` and `reviewer` brief. The first row — "the released plugin behaves this way for a consumer": the installed plugin in a consuming repo, observed by the user. The Ceiling ("this skill triggers", "the engine produces good findings") is there too. A gate attests to form, not to behaviour (realm `@nick/craft`, #126). Learned a carrier the table lacks — write the row there at once.

## Realm ↔ repo: what lives where
| Concern | Repo | Realm |
|---|---|---|
| Code, configs, lockfiles | ✓ | |
| Commands, conventions, stack | ✓ (AGENTS.md) | |
| Reality carriers | ✓ (REALITY.md) | |
| Gotchas | | ✓ rule nodes; this file and code reference them |
| Branch state, what is in flight | git + PR body (from the case lines) | ✓ (the transformation's `genre=hint` seed) |
| Methodology, ontology | | ✓ |
| Decisions | | ✓ (a node, at once) |
| Substantive questions, obligations | | ✓ (vimarshas) |
| Plans | | ✓ (the transformation map) |
| One-off task, work progress, shift handover | | ✓ (the case log) |
| Commit history, PRs, SHAs | git | (never in the realm) |

**No `HANDOVER.md` is created**: branch state already has homes — `git branch`/`log` and the open PR's body (from the case lines), node modes, the transformation seed; a hand-written file is the only one of them that goes stale silently. Forge unreachable — progress is read from modes and the seed.

## Commands
| What | Command |
|---|---|
| Unit tests | `npm test` (`vitest run`; files in `vitest.config.mjs`) |
| Lint (zero-warning, identical to CI; type-aware rules over the `lib/` and `opencode/plugin/` programs) | `npm run lint` — read the raw exit code (needs `npm ci` and `npm ci --prefix opencode/plugin`) |
| Typecheck the OpenCode plugin — `*.ts` and every `*.mjs`, tests included, at `lib/`'s maximum strictness (checkJs, JSDoc types, the plugin's own Node typings) | `npm run check:types` (needs `npm ci` and `npm ci --prefix opencode/plugin`: the plugin's tests import `vitest` from the root) |
| Typecheck `lib/*.mjs` at maximum strictness (checkJs, JSDoc types, Node 22 typings; tests included) | `npm run check:types:lib` (needs `npm ci` and `npm ci --prefix opencode/plugin`) |
| Typecheck the engines' own code `workflows/*.js` at the same strictness (sandbox globals in `lib/workflow-sandbox.d.ts`), plus typescript-eslint's `no-unsafe-*` rules at zero on the same program | `npm run check:types:workflows` (same prerequisites) |
| Syntax-check workflow scripts; byte-compare inlined regions; inlined code is strictly typed | `node lib/check-workflows.mjs` (needs `npm ci --prefix opencode/plugin` for tsc; `--fix` regenerates the regions) |
| Skills and agents (frontmatter + `craft:<slug>` refs) | `node lib/check-skills.mjs` |
| Delivery parity of review agents | `node lib/check-delivery-parity.mjs` |
| OpenCode agent/command frontmatter | `npm run check:opencode-frontmatter` |
| Eval corpus shape | `node lib/check-evals.mjs` |
| Unused files, exports, dependencies (config `knip.config.js`; an inlined export is used only where an engine calls it — listing it in a `craft-inline` fence is not a use) | `npm run check:dead:production` (tests excluded: an export only a test uses is dead) and `npm run check:dead` (tests included: devDependencies, packages tests import); both need `npm ci` and `npm ci --prefix opencode/plugin` |
| Plugin manifests | `npx --yes @anthropic-ai/claude-code plugin validate . --strict` |
| Audit the OpenCode plugin's locked production closure (blocking at high in CI; needs the network, so offline it is CI's to run — not reproducible, realm #141) | `npm audit --prefix opencode/plugin --omit=dev --audit-level=high` |
| Static analysis, semgrep public rule sets (CI job `semgrep`, image pinned there; the rules come from the registry per run, so not reproducible) | `semgrep scan --metrics=off --error --strict --timeout 0 --max-target-bytes 0 --config .semgrep/child-process.yml --config p/javascript --config p/typescript --config p/nodejs --config p/security-audit --config p/secrets --config p/default lib opencode/plugin workflows` |

There is no formatter and no pre-commit hook: run every row above before pushing (the audit and semgrep rows only with network; offline they are CI's to run); CI runs the same steps (two jobs: `test`, and `semgrep` for the semgrep row). Not a gate: `node lib/analyze-runs.mjs` reads the run store (`--round-pairs` for re-review cost pairs). What each gate does not cover — realm `@nick/craft`, #121.

## Project structure
- `skills/` — 32 skills, one directory each with a `SKILL.md`.
- `agents/` — 5 Claude Code review agents (`rust-reviewer`, `nix-reviewer`, `rust-architecture-reviewer`, `rust-security-scanner`, `rust-miri`).
- `workflows/` — scripts for the Workflow tool: `review.js` (the review engine, the hottest surface), `adversarial-review.js`, `rust-audit.js`, `triage-findings.js`, and the `rust-review.js`/`nix-review.js` entry points.
- `lib/` — the CI checkers (`check-*.mjs`), the run-record write path (`run-record.mjs`, `run-logging.mjs`, `craft-log-run.mjs`), the modules inlined into the engines, the engine harness (`engine-harness.mjs`), `analyze-runs.mjs`, and their tests.
- `evals/` — the skill-triggering corpus (`evals.json`) and its README.
- `opencode/` — the parallel OpenCode delivery: `agents/`, `commands/`, `plugin/` (TypeScript), `scripts/`.
- `docs/` — `LESSONS.md`, `observability.md`.
- `.claude-plugin/` — the plugin and marketplace manifests.
- `.claude/` — `settings.json` (hooks) and `agents/` (the seven role agents for working on this repo; not shipped).
- `MAP.md` — a map of the repo's contents; `README.md` — the human-facing entry point.

## Code conventions
- **Meaning lives in the realm, code references it**: a comment carrying rationale, discarded alternatives or the shape of an integration is a node; in code — "(realm `@nick/craft`, node #N)", for the discarded too ("not cached: #N"). Mechanics — in words in place. Having cited a node, check it says that; it diverged — fix the node. This repo is public (MIT, marketplace): references belong in `lib/` and `workflows/` code, not in `README.md`, `MAP.md` or skill bodies.
- **A skill's or agent's `description` is delivery, not decoration**: a skill loads by its description, so a rule living only in the body never fires. Change a skill's behaviour — re-read its `description` in the same move.
- **No runtime dependencies**: what ships rests on the Node standard library; the root `package.json` is `private` with devDependencies only — the test runner (Vitest, realm `@nick/craft`, #140) included (#124).
- `eqeqeq` is `{ null: 'ignore' }` on purpose: `x != null` means "neither null nor undefined"; do not "fix" it to `!==`.
- **Testing discipline**: unit tests cover `lib/**` and `opencode/plugin/**`; workflow scripts are exercised through `lib/engine-harness.mjs`, skill bodies only by static checkers. No coverage threshold. Logic that must be executed and sits in `workflows/*.js` is extracted into `lib/` and inlined back (realm `@nick/craft`, #120).
- **Gotchas do not live here**: they are rule nodes on the realm steps they constrain — #119–#126 for the gate, the two deliveries, inlined regions and run records; reference them here and in code.

## Review: craft reviews itself with its own engine
- **A review request goes to the background**: dispatch the handler (a workflow via the Workflow tool, or an agent with `run_in_background: true`) and keep working; report the verdict when it completes. A synchronous review only on explicit request.
- **Always a fresh agent**: every review, re-reviews included, is a new agent with a clean context — never `SendMessage` to a prior one; restate the diff range and intent each time.
- **Self-review is a gate in the authoring loop**: before `gh pr create` run `craft:review` on `git diff main...HEAD` → `craft:triage-findings` → `craft:addressing-findings` → re-review with a fresh agent, until the verdict is **Approve** (or **Warning** with each remaining item justified in the PR body).

| Scope | Handler |
|---|---|
| A diff before commit or merge (default) | `craft:review` workflow — auto-detects Rust/Nix |
| Force Rust-only / Nix-only | `craft:rust-review` / `craft:nix-review` |
| Mixed or non-Rust/Nix diff; money-path invariants | `craft:adversarial-review` (not `review --strict`, the harsh mode of the same engine) |
| One-off single pass without a workflow | agent `craft:rust-reviewer` / `craft:nix-reviewer` |
| Whole-project structural audit | agent `craft:rust-architecture-reviewer` |
| Security / dependencies / unsafe surface | agent `craft:rust-security-scanner` |
| `unsafe` under Miri | agent `craft:rust-miri` |
| Full audit, one synthesized report | `craft:rust-audit` workflow |

## What to update when
- `AGENTS.md` — **what can be learned from a realm node is not written here**; it holds what is needed before an agent reaches the realm (commands, the entry into orientation, invariants a linter cannot express, forks that must stop you) and changes when those change. Cleaning out prose means moving it into the carrying nodes, not deleting it.
- `REALITY.md` — when a claim class's carrier appears, changes or turns out unreachable; dated measurements go to the realm.
- The `@nick/craft` realm — every merge ("Session lifecycle").

## Git workflow
- **Forge**: GitHub (`git@github.com:gurinderu/craft.git`); CLI `gh`. Observe with `gh pr checks <n> --watch`, `gh pr view <n>`; trunk as the forge sees it — `gh api repos/gurinderu/craft/commits/main --jq .sha`. Never treat a local ref as current — `git fetch origin main` first.
- **Conventional commits** (`feat:`/`fix:`/`chore:`/`refactor:`/`docs:`/`test:`) — release-please parses them, so the prefix carries the version; branches `feat/…`, `fix/…`, `chore/…`; PR titles in the same format.
- **No co-author trailer and no "Generated with Claude Code"** — neither on commits nor in PR bodies.
- **Gate before push**: every row of "Commands" (the audit row needs the network — offline it is CI's); there is no pre-commit hook and no single gate call yet (cover, "Gate").
- **Push, review, then PR**: push the branch so the reviewer can read `origin/<branch>`; open the PR once the cold review's verdict is in and its findings are worked (above). A branch whose review is done does not live without a PR.
- **Definition of done**: a PR into `main`, `gh pr checks <n> --watch` green (one job, `test`; a red one means reading the log for the failed step), merged without conflicts. release-please cuts releases in a separate PR — merging a feature is not a release; `CRAFT_VERSION` in `review.js` moves with the manifest.
- **Never** `--no-verify`, `--force`, `--no-gpg-sign`, `git reset --hard` without an explicit instruction.

*(iskronify: contract 18, stamp 2026-10-02 — propose a re-run when the installed iskronify's description names a higher contract or when the sources this file was derived from have moved after this date.)*
