# craft — collection map

The plan for `craft`: an opinionated set of engineering skills that fully own craft's **Rust** and
**Nix** knowledge and stay **self-contained** — no plugin dependencies, no generic
engineering-process content. It replaces `rust-skills` entirely.

## Principles

1. **Own the domain; leave generic process out.** craft carries only Rust/Nix domain knowledge.
   The language-agnostic *discipline* (the debugging method, verification, how to plan or run a
   development process) is intentionally out of scope — craft names no external process skills and
   declares no plugin dependencies; bring your own. craft may ship a role that runs the cycle with
   craft's own tools (memory, review, triage, the fix loop — `develop`), and that role yields to
   the consumer's declared process: a role or rule the project declares for a step runs that step.
   A SessionStart hook (Claude Code and Codex; the OpenCode plugin carries the same work-moment
   lines) tells a repo that declares its own roles or work rules how they
   run that cycle with craft's tools, again when a message asks for review work and to a subagent
   that work is handed to, and, when the session dispatches the repo's own reviewer agent, to run
   the same range through craft's review engine too; it is silent elsewhere and can be switched off.
   Skills reference *each other* — that cross-linking is the collection's cohesion.
2. **Concrete over Socratic.** Good/Bad code and decision tables, not just "ask yourself…".
   (`rust-skills` is reasoning-first; `craft` is action-first.)
3. **Organized by task, not by error code.** One skill per thing you're *doing*
   (testing, reviewing, handling errors), not per compiler error number. Fewer, fatter skills.
4. **Progressive disclosure.** Lean `SKILL.md` entry + sub-files loaded on demand.
5. **No internal duplication.** Each topic is owned by exactly one skill; others point to it.

## Naming

- Skills: `<lang>-<topic>` (e.g. `rust-testing`). `craft` is multi-language over time —
  the prefix keeps namespaces clean once `go-…`, `ts-…` etc. appear.
- Agents: by role (`rust-reviewer`).
- Cross-cutting/language-agnostic skills (later): bare topic name (e.g. `git-workflow`).

## Conventions

- Crate versions in examples track the latest stable release; `edition = "2024"`.
- Skills reference **each other** (e.g. `rust-review` points at `rust-testing` for how to write
  missing tests): principle 1. A lean `SKILL.md` entry plus sub-files loaded on demand: principle 4.

## Rust skill set

Status: ✅ done

| Skill | Status | Scope | Does NOT cover (owner) |
|---|---|---|---|
| `rust-testing` | ✅ | unit/integration/doc, async, rstest, proptest, cargo-fuzz, cargo-mutants, mockall, insta, testcontainers, coverage, runner, CI | benchmarks → `rust-performance` |
| `rust-review` | ✅ | cargo gate, dependency-context step (review against pinned versions), severity checklist + **ID-tagged rule catalog** (`rules.md`), verdict; **exclusion catalog** — false-positive precedents + the `KEEP-*` non-reasons, each demanding a trace (`fp-rules.md`); premise grounding (`whereChecked`); the mirror walk (enforcement asymmetry); measured severity magnitude; **public-API design pass** (Rust API Guidelines checklist → `api-design.md`); requesting a craft review (agent dispatch + crafted brief); the Rust "what proves what" verification table | *how* to fix → topic skills; *how* to test → `rust-testing` |
| `rust-errors` | ✅ | `Result`/`Option`, `?`, domain failures vs defects (ZIO model), thiserror vs anyhow, library-vs-app design, recovery/retry/circuit-breaker | panics as control flow → `rust-idioms` |
| `rust-ownership` | ✅ | borrowing, lifetimes, `Cow`, smart pointers (`Box`/`Rc`/`Arc`), interior mutability (`Cell`/`RefCell`); fixes for E0382/E0597/E0499/E0502 | cross-thread sharing/`Send`+`Sync` → `rust-concurrency` |
| `rust-concurrency` | ✅ | threads vs async, `Send`/`Sync`, `Arc<Mutex>`, channels, tokio, deadlocks, lock-across-await | single-thread `Rc`/`RefCell` → `rust-ownership` |
| `rust-traits` | ✅ | generics, trait bounds, static vs dynamic vs **enum dispatch**, object safety, type-driven design (newtype, typestate, `PhantomData`, sealed) | lifetimes mechanics → `rust-ownership` |
| `rust-performance` | ✅ | measure-first, criterion/divan benchmarks, profiling, build config (LTO/codegen-units/target-cpu), PGO, heap allocs (arenas, compact strings), hashing, type sizes, iterators, safe SIMD/autovectorization, inlining & code layout (`#[cold]`) | correctness tests → `rust-testing`; `get_unchecked` / arch-specific SIMD intrinsics → `rust-unsafe` |
| `rust-unsafe` | ✅ | `unsafe`, raw pointers, FFI, `// SAFETY:` invariants, `#[repr]` layout, UB, Miri | safe abstractions → `rust-ownership` |
| `rust-idioms` | ✅ | idiomatic style, naming, clippy lints, rustdoc conventions, anti-patterns & common mistakes (catalog of Good/Bad) | the review *process* → `rust-review`; publish-doc/semver → `rust-ecosystem` |
| `rust-ecosystem` | ✅ | crate selection, `Cargo.toml`/deps, features, workspaces, edition/MSRV, project layout, publishing (semver/docs), build.rs, no_std, cross-compilation | build profiles → `rust-performance`; naming → `rust-idioms` |
| `rust-architecture` | ✅ | hexagonal / ports & adapters: domain core, ports as traits, adapters, dependency inversion, domain modeling, module layout, CQRS & event sourcing | dispatch → `rust-traits`; domain errors → `rust-errors`; port mocks → `rust-testing` |
| `rust-architecture-review` | ✅ | architecture-audit rubric: whole-project dependency graph, severity-tiered checklist (cycles, layer leaks, god modules) and over-engineering, Healthy/Concerns/At-risk rating; read by `rust-architecture-reviewer` | the patterns themselves → `rust-architecture` |
| `rust-security` | ✅ | dependency vulns (cargo-audit/RUSTSEC), supply chain & licenses (cargo-deny), unsafe surface (cargo-geiger), code patterns/taint/custom rules (semgrep) | code-smell review → `rust-review`; unsafe soundness → `rust-unsafe` |
| `rust-plugins` | ✅ | extensibility: trait-objects vs scripting vs RPC vs WASM vs cdylib, chosen by trust boundary; FFI/abi_stable + wasmtime/extism | FFI mechanics → `rust-unsafe`; dynamic ports ≈ `rust-architecture` |
| `rust-macros` | ✅ | metaprogramming: macro_rules! and procedural macros (derive/attribute/function-like) with syn/quote, cargo-expand, trybuild | "same logic over types" → `rust-traits` first |
| `rust-navigation` | ✅ | LSP navigation via rust-analyzer: go-to-definition, find-references (impact before rename), hover, document/workspace symbols, trait implementors, call hierarchy; text-tool fallbacks when no LSP | onboarding *method* → `codebase-onboarding`; acting on references → `refactoring`; dispatch choice → `rust-traits` |

## Domain skills

| Skill | Status | Scope | Builds on |
|---|---|---|---|
| `rust-web` | ✅ | axum/tokio/tower/sqlx: routing, extractors, state, `IntoResponse` errors, db pool, middleware, graceful shutdown (wiring-only; SIGTERM signal pattern → `rust-cloud-native`), auth (JWT/argon2), OpenAPI (`utoipa`) | `rust-architecture` (inbound adapter), `rust-errors`, `rust-concurrency`, `rust-security` |
| `rust-cli` | ✅ | clap (args/subcommands/config + figment), output & exit-code conventions, and full-screen TUIs with ratatui (`tui.md`) | `rust-errors` (CLI errors), `rust-concurrency` (TUI background work) |
| `rust-fintech` | ✅ | exact decimal (rust_decimal), `Money` type + currency, rounding/allocation, idempotency, double-entry ledgers | `rust-traits` (newtype), `rust-errors`, `rust-testing` (invariants) |
| `rust-cloud-native` | ✅ | gRPC (tonic), observability (tracing + OpenTelemetry), health/readiness, 12-factor config, graceful shutdown, lean containers | `rust-web`, `rust-concurrency`, `rust-errors`, `rust-security` |
| `rust-embedded` | ✅ | bare-metal/MCU no_std: heapless, peripheral-ownership singletons, embedded-hal drivers, ISR-safe sharing (critical-section Mutex), RTIC vs Embassy (`concurrency.md`), defmt/probe-rs | `rust-ecosystem` (no_std/targets), `rust-ownership` (interior mutability), `rust-concurrency` (async model), `rust-errors` |
| `rust-ml` | ✅ | ML/numerics: framework matrix (candle/burn/tch/ort/dfdx/linfa) (`frameworks.md`), tensors & dtypes (f32/f16/bf16), determinism, zero-copy weights (safetensors), model serving (load-once `Arc`, `spawn_blocking`, batching, GPU) (`serving.md`) | `rust-ownership` (tensor copies), `rust-concurrency` (rayon/spawn_blocking), `rust-web` + `rust-cloud-native` (serving), `rust-performance`, `rust-security` (pickle RCE) |

Other domains (IoT, gamedev, …) and live-data tooling (docs lookup, crate research) remain
open backlog.

## Nix skill set

Status: ✅ done

| Skill | Status | Scope | Does NOT cover (owner) |
|---|---|---|---|
| `nix-flakes` | ✅ | flake.nix inputs/outputs schema, pinning with flake.lock, standard outputs (devShells, packages, nixosConfigurations, homeConfigurations), flake-parts / flake-utils structuring | derivation details → `nix-packaging`; dev shell contents → `nix-dev-env`; system configs → `nixos` |
| `nix-packaging` | ✅ | stdenv.mkDerivation + phase model, fixed-output hashes for src fetchers, language-builder hashes (cargoHash, vendorHash, npmDepsHash), lib.fakeHash → real-hash workflow, meta attributes | flake wiring → `nix-flakes`; dev shells → `nix-dev-env` |
| `nix-dev-env` | ✅ | pkgs.mkShell, devShells.default, direnv + use flake, writeShellApplication for lint-checked scripts, Nix formatters (alejandra, nixpkgs-fmt), linters (statix, deadnix), pre-commit-hooks.nix wiring | flake plumbing → `nix-flakes`; packaging derivations → `nix-packaging` |
| `nixos` | ✅ | NixOS/nix-darwin module shape, typed options (lib.mkOption), composing modules, nixosConfigurations, secrets (agenix/sops-nix), cross-platform (nix-darwin + Home Manager), systemd units | flake output wiring → `nix-flakes`; dev environments → `nix-dev-env` |
| `nix-review` | ✅ | Nix code-review rubric: flake quality gate (nix flake check, formatter --check, statix, deadnix, nix build/eval), severity-tiered checklist (purity, reproducibility, injection, packaging, dev-env, modules, maintainability, deps), Approve/Warning/Block verdict, "what proves what" table | *how* to fix → topic skills (`nix-flakes`, `nix-packaging`, `nixos`); running the review agent → `nix-review` workflow |

## Agents

Tool-runner agents (run tools → interpret → report a verdict, in their own context). Each pairs
with a skill for the rubric and degrades gracefully when a tool is absent.

| Agent | Runs | Rubric skill |
|---|---|---|
| `rust-reviewer` | a Rust review by hand (the `review` workflow runs its Rust lenses on `review-task`) = ad-hoc whole-diff review that runs the gate itself (a CI check only informs) and returns a verdict, at most Warning when the gate could not be established | `rust-review` |
| `nix-reviewer` | a Nix review by hand (the `review` workflow runs its Nix lenses on `review-task`) = ad-hoc whole-diff Nix review (nix flake check / statix / deadnix gate + verdict) | `nix-review` |
| `rust-architecture-reviewer` | whole crate/module dependency graph audit | `rust-architecture-review` |
| `rust-security-scanner` | cargo-audit/deny/geiger + semgrep | `rust-security` |
| `rust-miri` | `cargo +nightly miri test` (UB) | `rust-unsafe` |
| `engine-service` | the engines' service steps (the `review` driver's `craft review` calls and the binary fetch, checkpoints and the run record); defined with `omitClaudeMd: true`, so that it is not handed the project's instructions; not for review judgement | — |
| `review-task` | one task of the `review` driver that names no agent (a general or SQL lens, a scout, the dedup, a verifier, an adjudicator, the critic), read-only with Read, Grep, Glob and Bash; defined with `omitClaudeMd: true` and no Skill or MCP tool, so it is handed neither the project's instructions nor the skill listing; the memory's recall and the code-graph tasks keep the default type | — |

clippy/test/coverage stay as commands inside `rust-reviewer` / the testing tooling — not separate
agents (would duplicate).

## Workflows

Multi-agent orchestration scripts that compose the agents above (referencing them by `agentType` —
internal to the plugin, no external dependency). They are authored under `integrations/claude-code/src/`; `integrations/claude-code/workflows/` holds the
copies the harness loads, generated from `integrations/claude-code/src/` without their line comments (`npm run build:engines`) and
committed. The review's knowledge — lens briefs and prompt templates (`content/prompts/`, `{{name}}`
placeholders), the schemas its agents answer in (`content/schemas/<name>.schema.json`) and the Rust, Nix, SQL, runbook and
general profiles' rosters (`content/profiles/rust.json`, `nix.json`, `sql.json`, `runbook.json`, `general.json`: the
runbook profile's one `runbook` lens (`content/prompts/lens-runbook.md`) over a changed Markdown file whose shell
blocks or numbered steps run commands against external systems; the SQL
profile's `sql-migrations` and `sql-queries`, the latter also held by the Rust and general profiles behind
the embedded-SQL signal; the general lenses, complexity among them behind a code-metrics index and
`design` behind the structure signal or `optional=design`, which
the Rust and Nix profiles `extends`, each lens of their own replacing the general one of its id or
added, `exclude` leaving out those that do not fit, `securityFloor` naming what the security floor adds —
resolved once at load by
`cli/crates/craft-review/src/profile/inherit.rs`) — is data under `content/`, compiled into the Rust CLI; the
templates an engine still renders itself (memory recall among them, and `triage-findings`' gather, validate and plan
prompts and answer schemas, `content/prompts/triage-*.md` and `content/schemas/triage-*.schema.json`, read through
`integrations/shared/triage-content.mjs`) are inlined into it by the build.

| Workflow | Composes | Output |
|---|---|---|
| `review` | the review of a diff in any language, the driver of the Rust CLI's step protocol: the binary decides every step (each changed file to its profile — Rust, Nix, SQL or the general lenses —, the gate, the scouts, the lens rounds until dry or the run's agent budget, verification, memory, re-review rounds chained under `~/.craft/runs/cli`); the protocol was observed end to end in a live session (craft 0.41.0, a Rust diff, finished with Approve), the full-lens review that followed it not yet; by design `engine-service` runs `craft review start`/`submit`, the tasks each step hands out run in parallel, each reading its prompt file and writing its answer file in the run directory, and the engine holds no review logic of its own; the binary files the run's telemetry itself (`--record`: a checkpoint as each phase ends, the record when the run finishes, written by its own store writer, byte for byte as `integrations/shared/craft-log-run.mjs` writes them; not yet observed live), the engine only the INCOMPLETE record of a run the binary never finished | a `## Verdict` block with the verdict line the binary printed, and the path of the report it wrote |
| `rust-audit` | gate once + per-crate CLI review (gate off) + inter-crate contracts + architecture + crate-decomposition + security + miri + semver + build-matrix + deps + unused-crates (verified) + tests-cov (parallel) | one synthesized severity-ranked report |
| `triage-findings` | gather → sift by project memory → validate (parallel, per finding) → plan (barrier) | one ordered fix plan (writing-plans format) + triage ledger; no edits |

### How each one runs

The `review` workflow's optional arguments: post the findings on the PR (`comment`), resume a run stopped by the
usage limit (`run=`), narrow to a directory (`path=`).

`integrations/claude-code/workflows/review.js` is the diff review for any language. It drives the `craft` binary (the Rust
CLI in `cli/`, fetched from this version's GitHub release unless `craftBin` names a local build), which
decides every step: each changed file goes to its profile — Rust, Nix, SQL, a Markdown runbook (a file whose
changed lines touch a shell block's or numbered step's command against an external system, walked step by step
as a procedure by the `runbook` lens; not yet observed live), or the general lenses for
source in any other language (correctness, security, money, concurrency, errors, performance, intent,
tests, maintainability, compat, invariants, negative-space, design and, behind a code-metrics index,
complexity — `design` judges the decisions a change makes (a new abstraction, source of truth,
boundary, format, dependency direction or engine) and runs by itself when the diff adds a module,
crate, public type or format, or on `optional=design` (not yet observed live); the Rust and Nix profiles extend them with their own lenses, Nix leaving out those that
do not fit) — the mechanical gate runs, a scout per profile picks lenses, the lenses
loop until dry or until the next round would pass the run's agent budget, the findings are deduplicated and verified, and the binary writes one report with a
verdict; the workflow only runs the agents each step hands out. A later run of the same branch builds
on the earlier one (reviewing the fix commits, re-judging the findings it left open) unless `fresh`.
`craft init` (the `craft:review-init` skill) writes your own profile of the repository, whose
integration points the review fetches and reads at their deployed version, and whose CI map — which
check of the project's CI runs clippy, the tests, fmt or the build, on which command line — the
gate reads for the head when it cannot build the branch itself: a red check blocks, a green one is
reported and never passes the gate.

`integrations/claude-code/workflows/rust-audit.js` is the full pre-release audit: a scout detects the diff base, `unsafe`,
the workspace crates and their dependency edges, then many dimensions run in parallel — per-crate
review, inter-crate contracts, architecture, crate-decomposition, security, Miri (if `unsafe`),
semver, build-matrix, deps, unused-crate detection (with verification), and test/doc health — and
a final step synthesizes one severity-ranked report.

`integrations/claude-code/workflows/triage-findings.js` gathers findings (craft agents + GitHub PR comments), sifts out what
the project's memory already settled, validates the rest, dedups and conflict-checks them, and
renders one ordered fix plan + a triage ledger (and the issues to file for findings the PR did not
introduce) — no edits. A finding counts as not introduced by the PR only when it was shown at the
commit the PR forks from: pass that as `prBase` (`git merge-base origin/<trunk> <reviewed head>`)
only when the reviewed head is a branch diverging from trunk, together with `base` = the reviewed
head's SHA, and leave it out on trunk or with no branch (it counts only beside a `base` it differs
from: with no `base`, equal to it, or `HEAD`, it is absent); without it such findings come back as
`needs-decision`. `base` is the ref the findings were generated against — the reviewed head — which
validation pins to.

The workflows and the standalone agents emit a structured run record after each run; see
`docs/observability.md`.

From a session in the repository to audit, run the workflow with the absolute path to the
installed plugin root and a fixed diff base (replace `<plugin-root>` with that path):

```
Workflow({ scriptPath: "<plugin-root>/workflows/rust-audit.js", args: { base: "origin/main", craftRoot: "<plugin-root>" } })
```

`args.base` is optional — without it the scout falls back to
`merge-base HEAD origin/main` → `main` → `HEAD~1`.

## Hooks

What craft says into a session on its own, and when. The Claude Code hooks file (`integrations/claude-code/hooks/hooks.json`) is also the one the Codex plugin names.

| Hook | What it does |
|---|---|
| `SessionStart` (Claude Code) | When the repo declares its own agents (`.claude/agents/*.md`) or work rules (an `AGENTS.md` / `CLAUDE.md` that names the process: pull request, PR, code review, reviewer, review loop, before merging), adds four lines of context: the repo's roles and rules win on every step they cover, whichever declared role develops there runs its cycle with craft's tools (`craft:memory` before the work, `craft:develop`'s review loop before a PR), and a role running as a subagent hands the review loop back to the main session. Silent otherwise; off with `CRAFT_ROLE_HOOK=0` or a `craft-role-hook: off` line in `AGENTS.md` / `CLAUDE.md`. These hooks, the two below and the OpenCode one are the `craft` binary of the plugin's version (`craft hook …`), run from `~/.craft/bin/<version>/`; a hook never waits for it: where it is not there yet and the repo declares roles or rules (the switch on), the start hook downloads it in the background and says so in one line, the others say so on stderr, and they speak from the next session on; elsewhere they say nothing. Each run appends one line to `~/.craft/hooks.jsonl` (spoke or why silent; rotated past 256 KiB), which `integrations/shared/analyze-runs.mjs` reports beside the review runs made after it first spoke in their repo |
| `UserPromptSubmit`, `SubagentStart` (Claude Code) | In the same repos and with the same off switch: on a message that asks for review work — English words such as review, findings, PR comments, pull request, merge request, a PR or MR link, or a comment or fix word beside a PR word ("check the PR for new comments") — adds its lines (eight for findings, five for a review) once per session for each kind of request (again after a compact or clear). A message written mostly in another script than Latin (Russian, Greek, Chinese…) gets one conditional text instead, the first in a session (again after a compact or clear), standing for that and every later request in the session and letting the model decide whether one asks for findings work or a review; each later such message gets one reminder line that those lines apply to it if it is about findings, PR comments or a review. The conditional text and the per-kind texts do not stand in for each other: an English request after it still gets its kind's lines, and a non-Latin one after them still gets the conditional text. It answers only a human's word: a subagent's report or a task notification the harness hands back as a prompt gets nothing, except one conditional line (if the report completes the fixes, re-review before posting replies) on the first subagent report in a session that heard the findings lines, again only after a compact or clear; a bare English "continue" ("keep going", "finish it") takes the kind of the session's latest prompt (none if that one asked for something else), or, as a session's first prompt, of the repo's latest prompt from another session within 12 hours; prompts it leaves unclassed are logged as `no-kind` for that. For findings: one call before the first tool call, `craft:addressing-findings`; right after it, the `craft:memory` recall for every path the findings touch, before triage; after the fixes are in and before any reply is posted, the re-review in the main session (the `craft:review` workflow on any language: Rust, Nix and SQL under their profiles, other source under its general lenses, in one run) until no Medium-or-higher finding is open; what the skill gives over working by hand; the main session holds the memory — it puts the records `craft:memory` recalls into each subagent's brief and records every triage disposition itself, right after triage (checking the `memory backend:` line); triage, whatever the number of findings, is the `craft:triage-findings` workflow launched in the main session (`report` = the findings written to a file whenever they live in a report, `pr` whenever there is a PR, at least one, and `prBase` with `base` = the reviewed head's SHA only when the reviewed head is a branch diverging from trunk — on trunk or with no branch `prBase` is left out and the findings claimed not this PR's go to the human), never handed to a subagent, and the main session files its issues; only the fixes may be delegated, with a ready line to paste into each fixer's brief with its file group that has the fixer never re-triage nor write memory and report a planned fix it finds wrong. For a review: `craft:develop` for the loop or, for one pass, the `craft:review` workflow on any language (Rust, Nix and SQL under their profiles, other source under its general lenses, in one run), both in the main session, never handed to a subagent; the same memory line; a ready brief line for a delegated reviewer, which reports findings only, changes no code and records nothing. In that session, a subagent started with the Agent tool gets five lines of its own (triage, replies and fixes per PR comments count as findings work; triage is never its own — asked to triage, it reports that back; it fixes a plan's file group with its verdicts as given, never writes memory and reports a planned fix it finds wrong; a pure review changes and records nothing) (craft's own agents get none: a `craft:` agent, one of craft's shipped agents by its bare name, or the Workflow tool's, none of them logged). Each firing goes to `~/.craft/hooks.jsonl` with its event, counted per event in the "craft hooks" section of `integrations/shared/analyze-runs.mjs` (the re-review line and the reminder line as rows of their own) (the review-run join stays on SessionStart) |
| `PreToolUse` on the Agent tool (Claude Code) | In the same repos and with the same off switch: when the session dispatches the repo's own reviewer agent, tells it to run the same diff range through craft's review engine too, in the main session. |
| `PostToolUse` on the Bash tool (Claude Code) | In any repository, with no role test and no switch: when a command said `pr create` or `pr new` and printed a pull request's URL, asks `gh pr view` for the PR's head and base and warns when the run store holds no finished full `craft:review` of that head and the PR's whole change, and says when it could not check. It runs the cached `craft` binary of its own version and never downloads it. |
| `chat.message`, `event` (OpenCode plugin) | The same request classes, repo test and off switch over OpenCode's plugin hooks: on a message asking for review work, appends a synthetic text part (eight lines for findings — with the recall before triage, triage in the session itself with the sift done by hand (OpenCode has no sift engine; its `triage-findings` tool only validates), and the re-review before replies, its own pass or `rust-review`/`rust-audit` — five for a review) once per session for each kind of request (again after a compaction; the first message in a non-Latin script gets one conditional text covering both kinds as a standing rule for the session, each later one a reminder line, and neither stands in for the per-kind texts), shaped as the Claude Code lines but naming what the OpenCode delivery ships: `addressing-findings` for findings, `rust-review` or the `rust-audit` tool (`/rust-audit`) for a review, the `memory` skill held by the main session, and a ready brief line for a fixer (the fixes only) or a reviewer agent; a repo's own `.opencode/agents` count as declared roles, craft's installed links there do not; a subagent session hears its own five lines on its first message when its brief asks for review work or its parent heard the prompt lines; the sessions the plugin's workflows open and craft's own agents hear nothing (unlogged). Logged to `~/.craft/hooks.jsonl` as `chat.message` and `session.compacted`. OpenCode has no session-start hook here |

## Documentation

- `docs/LESSONS.md` — operational lessons not derivable from the code: stable-numbered evidence entries folded into principles. Add one when something was learned at a cost.
- `docs/observability.md` — run-record store (`~/.craft/runs/`) emitted by the `review` / `rust-audit` / `triage-findings` workflows (the review's through the craft binary).

## Cross-cutting skills (language-agnostic)

| Skill | Status | Scope | Does NOT cover (owner) |
|---|---|---|---|
| `specs` | ✅ | specification by example / BDD / ATDD: requirements → Given/When/Then scenarios, choosing examples, outside-in | *running* scenarios / frameworks → per-language testing skill (`rust-testing` → cucumber) |
| `debugging` | ✅ | **Rust** debugging toolbox: minimal repro, `git bisect`/`cargo bisect-rustc`, `dbg!`/`tracing`/`RUST_BACKTRACE`, Miri/loom heisenbugs, `rust-gdb`/`rr` | Rust specifics → `rust-errors`/`rust-concurrency`/`rust-unsafe` |
| `refactoring` | ✅ | structure-not-behavior in tiny steps under green tests; characterization tests; named transformations | safety net → `rust-testing`/`specs`; smell catalog → `rust-idioms` |
| `codebase-onboarding` | ✅ | understand an unfamiliar repo first: map structure, find entry points/seams, trace one flow, confirm by building | changing it → `refactoring`/`rust-architecture`; bugs → `debugging` |
| `distributed-races` | ✅ | controller / reconcile-loop correctness as questions → answer needed → where to read it (`catalogue.md`, R1–R20): self-triggering writes, wake source per requeue outcome, foreign stale cache, permissions, protection lifetime, migration window, plus create/patch divergence, partial-failure strands, cleanup, status churn, feature gates, 409/404 races, swallowed errors, strict decode on shared streams, webhook failurePolicy, retry bounds lost on error paths, holds only an unwatched object clears, writes without a resourceVersion or UID fence, unchecked claims about external systems; the `reconciler` lens reads its catalogue | R7–R12 as `REC-001`…`REC-006` in `rust-review`; write-pair durability and retry idempotency → the `failure-windows` lens |
| `compatibility` | ✅ | backward compatibility as questions → answer needed → where to read it (`catalogue.md`, C1–C13): old data under the new shape, rolling deploy both directions, read-only alias, migration vs running code, CLI contract, config/env/chart surface, changed defaults, schema fields narrowed, API version lifecycle, IDL breaks, rollout order across components, renamed exported identifiers, regression vs standing state against the last released tag; the `compat` lens reads its catalogue | crate semver (`cargo semver-checks`) → `rust-ecosystem`; pre-existing objects a controller handles → `distributed-races` R6 |
| `sql-review` | 🧪 new, not yet observed in a live review | SQL code-review rubric (PostgreSQL): the lock each ALTER form takes, what rewrites a table since PG 11, the migrations checklist (locks, rewrites, NOT NULL, CREATE INDEX CONCURRENTLY, backfills, rollout order against the code, reversibility, migration-number conflicts) and the queries checklist (schema match, NULL and joins, transactions and isolation, indexes, N+1, injection), rule catalog `rules.md` (MIG-*, QRY-*) | the review itself → `review` workflow (its SQL profile; `sql-queries` also over Rust and other source whose changed lines hold a query string); Rust around the query → `rust-review` |
| `review-rules` | ✅ | language-independent review rules every lens and verifier reads beside its language rubric: severity capped by the named harm (`severity.md`), finding classes CONV/LIFE/RECOV/EXT/WIRE/RACE/FAIL/TEST/DOCS/MAINT (`classes.md`), search sweeps — sibling sweep, early-exit diff, attribution check, context before judgment, consequence of a false claim (`sweeps.md`), shared exclusions FP-002/KEEP-* (`fp-rules.md`), a Markdown runbook walked as a procedure (`runbooks.md`) | language-specific rules → `rust-review`/`nix-review`/`sql-review`; race and compatibility catalogues → `distributed-races`/`compatibility` |
| `memory` | ✅ | the project's decisions, project rules, lessons and open questions across sessions: one record shape, five verbs, deterministic backend order (explicit setting → memory MCP server by capability → harness project memory → `.craft/memory/` files on existing dir or consent → none), recall by scope + keywords returning only active matches; `backends.md` per store | run records, review ledger, telemetry → `addressing-findings` / `docs/observability.md` |
| `review-init` | ✅ | `craft init`: the reviewer's own profile of a repository, outside it (`~/.craft/projects/<id>/review.toml`) — the integration points (external systems the code talks to) with their source URL and deployed tag or commit; propose (the memory's `external` records with the revision each one's version file names, and manifest discovery) → ask the reviewer → write | library dependencies (a review finds them itself); the project's shared facts → `memory` |
| `codex-review` | 🧪 new, not yet observed in a real Codex session | Codex only: the review from a Codex session — one command, `bin/craft review run --backend codex`, the `craft` binary's own driver with each task its own `codex exec`; the binary's flags (`--base`, `--depth`, `--run`, `--concurrency`, `--models`, …) | Claude Code (the `review` workflow); a review by hand (`rust-review`, `nix-review`) |
| `develop` | ✅ | the development cycle up to a PR with craft's own tools: consumer roles first (a declared role or rule takes its phase, except the full review, where it runs beside craft's; one line per phase says whose) → `memory` recall → work → review loop (`review` → triage → `addressing-findings`), light by default — round 1 over the branch diff, each next over the fixed delta — until a round brings no open Medium+ finding, at most 4 rounds, then stop and tell the human → one full review (a strict fresh `review` over the whole branch diff for every diff, `rust-audit` only beside it for Rust, a declared reviewer or rule beside it too) → one `develop-cycle` record in the run store → PR; main session only | planning, test-first, debugging method → the project's own process; working findings alone → `addressing-findings`; a single review → the review workflows |
| `addressing-findings` | ✅ | the fix loop for review findings: gather (craft agents + GitHub PR comments) → normalize → triage (accept/reject/defer/needs-decision/conflict) → order → fix → verify → re-review → close the GitHub loop; triage always goes through the `triage-findings` workflow | the review *rubric* → `rust-review`; *running* the agents → `rust-audit`; *how* to fix → topic skills |

> **Out of scope:** the generic engineering-process method (systematic debugging, verification,
> requesting/receiving review). craft names no external process skills and keeps only the
> Rust-specific surface — `debugging`'s `techniques.md` toolbox, plus the cargo "what proves what"
> table and craft-agent dispatch in `rust-review`. Bring your own process-discipline skills.

## Build order

1. ✅ `rust-testing`, `rust-review` — the pilot pair (write + judge).
2. ✅ `rust-errors` — foundational, high reuse.
3. ✅ `rust-ownership` — the #1 Rust pain point.
4. ✅ `rust-concurrency`.
5. ✅ `rust-traits`.
6. ✅ `rust-performance`.
7. ✅ `rust-idioms`.
8. ✅ `rust-unsafe`.
9. ✅ `rust-ecosystem` — **core set complete.**

Plus `rust-architecture` (hexagonal) and the cross-cutting `specs`. Beyond the core: domains
(`rust-web`, `rust-cli`, …) and live tooling are open backlog. (Docs conventions live in
`rust-idioms`; publish-doc specifics in `rust-ecosystem` — no separate `rust-docs`.)

## Refactors

- ✅ `rust-review/examples.md` removed; the Good/Bad catalog now lives in `rust-idioms`
  (anti-patterns). `rust-review` keeps the rubric and cites `rust-idioms` for the fix.
- ✅ Rust API Guidelines gap-fill. Audited the collection against
  [api-guidelines](https://rust-lang.github.io/api-guidelines/) and added the missing items to
  their owning skills: `rust-idioms` (Deref-as-inheritance, out-params, surprising operator
  overloads, `FromIterator`/`Extend`, generic `Read`/`Write` by value, `Hex`/`Octal`/`Binary`,
  Debug-never-empty, iterator-type names, word order), `rust-traits` (`bitflags`,
  no-bounds-on-type-defs, private fields), `rust-ownership` (`Drop` rules: never-panic,
  no-async-in-drop), `rust-concurrency` (explicit `shutdown().await`), `rust-ecosystem` (stable
  public deps, `CHANGELOG`, `#[doc(hidden)]`, feature naming). New `rust-review/api-design.md` is a
  condensed C-guideline checklist that points to each owner — run on public-API diffs.

## Planned cross-links (ideas)

- `rust-concurrency`: a poisoned lock / `PoisonError` is a **defect** (see the failures-vs-defects
  model in `rust-errors`), not a domain failure.
- `rust-review`: add a HIGH item — domain error enum polluted with infrastructure noise that no
  caller branches on (should be opaque/`Internal` or a panic), per `rust-errors`.

## Migration vs rust-skills

`craft` now covers the `rust-skills` surface (core set complete); `rust-skills` can be
uninstalled. Remaining gaps: m14 (a deliberate skip — pedagogical/Socratic, against craft's
action-first stance), `domain-*` beyond web/cli/fintech/cloud-native/embedded/ML (such as IoT), and the
live-data/news tooling (crate/docs/changelog fetchers). LSP navigation is now covered by
`rust-navigation`. Rough mapping:

| rust-skills | craft |
|---|---|
| m01 / m02 / m03 | `rust-ownership` |
| m04 / m05 | `rust-traits` |
| m06 / m13 | `rust-errors` |
| m07 | `rust-concurrency` |
| m10 | `rust-performance` |
| m11 | `rust-ecosystem` |
| m15 + coding-guidelines | `rust-idioms` |
| unsafe-checker | `rust-unsafe` |
| (no equivalent) | `rust-testing`, `rust-review` |
| m09 (domain modeling) | `rust-architecture` |
| m12 (lifecycle: RAII/guards/lazy-init) | `rust-ownership` ([lifecycle.md](skills/rust-ownership/lifecycle.md)); pools → `rust-web` |
| LSP navigation skills (code-navigator/call-graph/symbol/trait-explorer) | `rust-navigation` |
| domain-embedded | `rust-embedded` |
| domain-ml | `rust-ml` |
| m14, other domain-* (e.g. IoT), live-data/news agents | deferred |

## opencode adapter

`integrations/opencode/` is a thin, contained adapter layer that makes the collection usable from opencode
(skills shared verbatim by symlink; 4 translated agent files and `review-task`, the read-only agent of the review's tasks; one TS plugin for OpenCode 1.x and 2.x —
its default export carries both entries, and a host layer (`host.ts`, with `host-v1.ts` and `host-v2.ts`)
gives the `rust-audit` and `triage-findings` workflows, the `review` tool (`bin/craft review run --backend opencode --events json`
through `integrations/shared/craft-review-run.mjs`, on the calling session's model, each task on 1.x its own `opencode run` on `review-task`,
without `--archived` and with subagent tasks on `review-task`; on 2.x `--delegate`, each task handed back to the plugin and run as a child
session of the calling session (`review-children.ts`, `child-run.ts`, the binary's `run/delegate.rs` and `run/delegate_read.rs`); the tool is not yet seen in a real OpenCode session) and craft's work hook one surface on either runtime; on 2.x the review's progress also
reaches the TUI's prompt footer through the `craft.review` RPC — `progress-rpc.ts` emits it, `review-footer.mjs` draws it, loaded by the TUI
from `plugin/tui/`, the directory `install.sh` links as `plugins/craft-review-footer`;
a symlink `install.sh` that also installs the plugin's locked dependencies; on 2.x the package `opencode plugin add`
installs, from the `opencode-plugin` branch's `opencode-v<version>` tag, whose plugin registers the agents, commands
(`/craft-review`, `/rust-audit`, `/triage-findings`) and skills itself through `plugin-content.ts` and `frontmatter.ts`).
Single source of truth: the skills are not duplicated. The design spec
that shaped this layer has been removed.

## Rust CLI

`craft runs recurring` reads up to 500 newest detail files and emits one JSON object of findings
confirmed on at least two branches of one repository. Selection and grouping are in
`cli/crates/craft-review/src/recurring.rs` and `recurring/`, reached by `cli/bin/craft/src/runs.rs` and tested through the
built binary in `cli/bin/craft/tests/recurring.rs` and `cli/bin/craft/tests/recurring/`. The addressing-findings and develop skills resolve
that binary by the package's existing downloader and call the native command. Equal groups use UTF-16 code-unit order,
independent of the host locale.

Manifest discovery and legacy external-record import live in
`cli/crates/craft-review/src/externals.rs` and `externals/`. `craft init`
(`cli/bin/craft/src/init.rs`, `init/memory.rs`, and `init/paths.rs` for its repeatable `--path`,
the manifests read in place of the walk) calls that library. Library coverage is in
`externals/tests/`; binary-boundary coverage is in `cli/bin/craft/tests/externals.rs`
and `externals/`. The embedded regex engine is pinned through `cli/Cargo.lock`.

`craft memory reindex --dir <memory dir>` (`cli/bin/craft/src/memory.rs`, its pure text work in
`memory/index.rs`, tests in `memory/tests.rs`) rebuilds `craft-memory.md`, craft's own index of
its records in the harness's project memory directory, and moves the per-record lines earlier
releases wrote out of the harness's `MEMORY.md`, leaving one pointer line; the memory skill's
`backends.md` calls it after each record write.

`cli/` is a Cargo workspace for `craft review`, designed so the binary decides a review's work and
a host (the `review` engine above) runs its agents. The step protocol was observed end to end
in a live session (craft 0.41.0, a Rust diff, finished with Approve); the full-lens review it runs
now is not yet observed live. `bin/craft` (the command: `craft review start | submit | status`, the step
protocol, with `--paged` writing a step to the run directory and printing it a page at a time, `craft review page` the next (`src/paged.rs`, read by `integrations/shared/cli-review-paged.mjs`); `craft review run --backend codex|pi|opencode`, which drives that protocol itself to the verdict, each task its own
`codex exec`, `pi -p` or `opencode run` process — or, with `--delegate`, handed back to the OpenCode plugin that runs it as a child session —, its progress as lines or `--events json`; `craft review probe`, one agent end to end; `filing_worker.rs` isolates a run-store write in a time-bounded child of the same binary; and `craft runs ls | show | stats | check | retro`, the run store read by streaming its files, a table or NDJSON), `crates/craft-agent` (one agent run through a
backend — the `claude`, `codex`, `pi` or `opencode` CLI — and many under a concurrency cap), `crates/craft-review` (the steps — each changed file to one profile (Rust, Nix, SQL, or the general lenses for source in
any other language, `content/profiles/`; a Rust or general file whose changed lines hold a query string also gets the
`sql-queries` lens, `src/embedded_sql.rs`; a Markdown file whose change touches a step — a shell block's or a
numbered step's command against an external system, added, changed or removed — goes to the runbook profile, read from the working tree,
`src/runbook.rs` and `src/runbook/` (both sides of the diff, the Markdown read by `pulldown-cmark`, pinned in
`cli/Cargo.lock`); a part that adds a module, crate, public type or format gets the `design`
lens, seeded with what it adds and, for Rust, the crate graph's new edges and the dev-dependency cycles they close; first round only, `src/design.rs`), the mechanical gate the binary runs itself before any lens (clippy and semgrep
for Rust, nix flake check, statix and deadnix for Nix: a red check blocks, a diagnostic on a changed line is a seed the
lenses and verifiers see, a tool not installed is named), the change's mutants once the Rust gate passed (`src/gate/mutants.rs`
and `src/gate/mutants/`: `cargo mutants --in-diff` in a worker process of the same binary, `__craft-mutants`, that runs beside the
lens rounds within its budget — the reviewer's profile's `[mutants]` section can name it or turn them off (`src/project/mutants.rs`) —;
joined when the rounds end, each mutant that survived in a function the change touched pooled as a tool's finding, and the report
saying what came of them or why they did not run), the reviewer's profile's `[lenses]` composition (`src/composition.rs`, read by `src/project/lenses.rs`: a lens
turned off leaves the plan, one held runs its first round only, the report naming each; never the security or a profile's safety lens,
the concurrency lens at most held; `--all-lenses` sets it aside for the release's full review; `src/composition/candidates.rs` sums each lens's yield over a repository's runs and offers the quiet ones, which `craft init` shows through `cli/bin/craft/src/init/lenses.rs` and writes with `--write --lens`), a scout per profile whose answer plans its lenses over its own files, the
consumers list, built at start beside the gate (`src/consumers/`: for each changed Rust symbol the lines outside the diff that name it —
callers, implementors and same-named declarations, places passing it as a value — from a name search, always run
(`names.rs`), a structural search for a name too common to search by text or past the name search's line cap
(`names/structural.rs`, with `structural/files.rs` the files it reads, `structural/reading.rs` one of them read and
`structural/around.rs` a trait's implementors and an enclosing module's re-exports; `names/paths.rs` and `names/paths/`: the paths that reach it — `T::name`,
`Self::name` inside an `impl` of `T`, `<T as Tr>::name`, `Tr::name` or `X::name` for a trait's item with `impl Tr for X`,
`m::name` and a bare `name` called or passed for a free function — each resolved to its full path from the file's module,
its `use` declarations (an alias, `{self as x}`, a glob) and its own crate's dependencies (`paths/resolve.rs`,
`paths/resolve/scope.rs`, `paths/declared.rs` with the standard prelude's names, `paths/imports.rs`, `paths/owner.rs`, `paths/reach.rs`), read from a tree-sitter syntax tree embedded in the binary
(`paths/syntax.rs`), so comments, strings and same-named items of another module or crate never match;
`names/crates.rs` reads each package's manifest, `names/unit.rs` a file's crate and module (`unit/root.rs` where a path's root leads, `unit/files.rs` a module's files); a call through a value is
not read), and,
when the reviewer's profile says codebase-memory answers, or records none and it answers on PATH (`src/consumers/cbm/`,
`graph.rs`, `graph/found.rs`), the checkout the review
reads indexed first within the list's graph budget (`cbm/reindex.rs`, one review at a time per project by a lock under
`~/.craft/cbm-locks/`: `cbm/lock.rs`; an index past the budget left to finish; always one project of craft's own per
repository moved to each checkout reviewed, never the profile's: `graph/target.rs`; nothing indexed when the change has
no symbol), its index checked to be of this very checkout and of a commit holding the base (`fresh.rs`) and read again after the questions (answers dropped
when it moved), the graph's callers merged in (`graph/sites.rs`: none from a checkout nested in this one) and, for the metrics lenses, the
numbers of the functions the change touches read after them within a floor of the budget kept for it (`graph/ask.rs`,
`graph/metrics.rs`, `cbm/functions.rs`), whether the complexity lens could look decided once (`src/complexity/look.rs`), the report
naming which sources built it and why the graph was not asked; the whole list
saved as `consumers.json` in the run directory, each lens task given its own scope's part of it — a directory slice the symbols its files declare, a unit batch the lines under its units — cut to a budget, the rest left in that file (`src/consumers/scope.rs`), to go through line by line; `craft
init` probes codebase-memory and writes `[code_graph]` into the profile, keeping a usable one it held while the graph
does not answer, a section of a shape it does not read taken as unusable rather than as an unreadable profile), the
lenses round after round until each profile's round finds nothing new or its plan's rounds are spent, the
floor, roll-up and dedup of their one pool, the mechanical re-anchor step (`src/anchor.rs`: a finding whose line is past
its file's end in the head, naming a symbol the file holds on exactly one line, is moved to that line, the report saying
which line it was corrected from), then verification as the plan buys it — a batch vote per file group of Mediums, one
vote per other finding routed alone, and for a Critical or High a cheap vote plus an authoritative one, the rest of the
plan's panel bought only when those two disagree — each finding's severity capped by the harm it names
(strict mode spares a maintainability finding and blocks on a confirmed one at Medium or above), a finding the project's
memory already rejected or deferred — recalled by one agent beside the scouts, plus the launcher's own records — set aside
under its own section when the code in its record's scope is unchanged since the record's commit — or, for a record
naming no commit, since the merge on the trunk of the pull request its links give (`cli/crates/craft-review/src/memory/anchor/pull.rs`),
else since the trunk's last commit before its date (`cli/crates/craft-review/src/memory/anchor.rs` and its
JavaScript twin `integrations/shared/prior-decision-anchor.mjs`) — a near miss between a
record and a finding decided by a match judge, then a finding a project rule covers set aside under its own,
decided by a rule judge — past their bounds (60 recalled paths, 100 records, 40 pairs per judge) the paths are
recalled by directory and the records and pairs closest to the reviewed paths kept, by
`cli/crates/craft-review/src/memory/bounds.rs` and its JavaScript twin `integrations/shared/memory-bounds.mjs`
(on a re-review a red team attacks each resolved Critical or High prior first;
the reviewed repository's own reviewing agents run as extra lenses beside the first round — named, or discovered on a light
pass among the session project's `.claude/agents`; on a large or security-sensitive plan a completeness critic names roster
lenses that should have run, which then run and whose findings are verified as a pass of their own; with `--unit-scope`,
off by default, each sliceable lens is confined to a batch of the Cargo crates the change touches, a contract lens runs
on each touched crate, and after the rounds a coordinator answers the questions the confined lenses left in their answers,
decides each finding that depends on one and judges the seam between the crates; with `--comment` the finished run
sorts its findings into defects and doubtful ones and posts the defects on the branch's PR through `gh` itself, never twice,
a line GitHub refuses going on its file; `craft review comment --run <dir>` does the same for a run already finished,
its record amended with what came of it; `craft review post --n <n> --as question|defect` posts one doubtful finding the reviewer chose by the same rules (`src/publish/doubtful.rs`) and records the choice; `craft pr rejections` reads a PR's review threads through `gh api graphql` into the decision records of the author's and maintainers' rejections (`src/rejections/`) — `content/parity/finding-post-cases.json` and `pr-rejections-cases.json` freeze what the JavaScript `finding-post` and `pr-rejections` they replaced built),
then a Markdown report of the findings by tier, the lenses that ran, the rounds and what the CLI does not run — rendered
from `content/`, which it compiles in, its plans, prompts and verification rules pinned by the shared cases in
`content/parity/`, with the run's state in `state.json` of its run directory, each task's prompt and
schema in its `tasks/` and each answer in its `answers/`, so no model copies them; with `start --record` the run files its own telemetry
into the run store through `crates/craft-store`, which writes the checkpoints, the record and its index line byte for byte as
`integrations/shared/craft-log-run.mjs` does, with no node, keeping what it needs between steps in `filing.json`, including the stopped parts whose
record has not landed, which every `--resume` files again first; `craft review status` carries that `filing` — the
record, its file and the step the run ended with — for a host that lost the step that said it), `crates/craft-step` (the step protocol
every kind of run shares, review now: the task and its kind, its prompt, schema and answer files, the answer checked against
its schema and asked for again, the notes on a refused answer file left in place (`src/left.rs`), the stop on the account's usage limit (`src/stop.rs`), the pending step and a task's status line; the review is its first kind, its phases, lenses,
memory and verification its own), `crates/craft-store` (the run store's writer and its streaming reader — a record filed as its
run built it, a triage's (`src/ready.rs`), and the section a run's answer leads with when a telemetry write did not land
(`src/lost.rs`) among them — its output held to the JavaScript writer's by `content/parity/store-cases.json`), `crates/craft-triage` (the triage of findings as the binary
runs it — `craft triage start | submit | status` on the step protocol (`src/step.rs`, `src/state.rs`; a submit's `--limit`, `--resume` and `--abandoned` in `src/step/halt.rs`), its run derived
at every step from its arguments and its agents' answers (`src/run.rs`, `run/`): the gatherers, repeats collapsed, the
batch sifted by the review's memory, the validators, the plan agent, their prompts (`src/prompts.rs`), a prior ledger's
settled verdicts carried, the noise classes and the issue class 1 files, the plan's ledger pinned, the plan's banners and
the run record, which `start --record` files in the run store itself before the plan is built, what it did kept in the
run's `filing.json` (`src/step/filing.rs`) — held to `triage-findings` by `content/parity/triage-cases.json`, which
`integrations/shared/triage-parity.test.mjs` writes; the Claude Code engine still runs the JavaScript triage)
and `crates/craft-tui` (progress as a phases → agents tree
on a terminal, one line per event otherwise); `test-support/` holds the one copy of a helper every crate's tests
include by path (an executable a test writes and runs). In `craft-store`, `js/string.rs` holds lossless JavaScript
strings, `js/coerce.rs` JavaScript's `Number()` and whitespace (the triage reads its values through the same `js`), `filing.rs` replays pending writes through `filing_io.rs`'s publication primitives, and `lock/turn.rs` coordinates local writers
with `lock/ticket.rs` validating immutable names. The writes made after a run — `craft runs enrich-cost` (`cost/`: the harness's per-agent transcripts counted once per message and sliced per record), `sorting-choice` (`sorting.rs`) and `develop-cycle` (`develop.rs`), answered in `posthoc.rs` and rewritten under the lock by `amend.rs` — are what the skills and engines run through `integrations/shared/craft-cli.sh`; `content/parity/cost-cases.json` and `posthoc-store-cases.json` freeze what the JavaScript enrich-cost, sorting-choice and develop-cycle wrote. `process_identity.rs` and its native modules query boot and process incarnations;
`bin/craft/src/process_identity.rs` exposes them through the hidden `__craft-process-identity` command.
The JavaScript counterparts are `integrations/shared/filing-transaction.mjs`, `integrations/shared/index-turn.mjs` and `integrations/shared/process-identity.mjs` (direct Linux reads,
cached-binary queries on macOS/Windows); `tests/lock_interop.rs` exercises both lock callers, and
`bin/craft/tests/process_identity.rs` exercises the real helper and Node admission across native platforms.
The toolchain is pinned in `cli/rust-toolchain.toml`;
CI's `rust` job runs `cargo fmt --check`, `cargo clippy` at zero warnings and `cargo test`, and checks that the
parity files the CLI owns (`verify-cases.json`, `plan-cases.json`, `prompt-cases.json`) regenerate unchanged, apart
from `npm run gate`. The release build for each of the release's five targets, with the native external-discovery
tests on it, is `.github/workflows/native-builds.yml`'s `init-native` job: on each push to main and on a pull request
that touches the build's inputs, not on every pull request. The CLI's version is the plugin's: release-please moves `cli/Cargo.toml` and
`cli/Cargo.lock` with the manifest, and its `cli-binaries` job attaches `craft-<target>.tar.gz` (the
binary at the archive root, `craft.exe` for Windows) and its `.sha256` to each release for Linux and macOS on x64
and arm64 and Windows on x64; `sh integrations/shared/craft-cli.sh --ensure --print-path` fetches the one for this platform and version into
`~/.craft/bin/<version>/` with no Node (`integrations/shared/craft-bin.mjs ensure`, through the REST API,
`integrations/shared/release-asset.mjs`, when the download URL answers 5xx or not at all, is the fallback where there is no sh;
`GITHUB_TOKEN` or `GH_TOKEN`, if set, is sent to the API only),
which the `review` engine runs when no `craftBin` is given. The other hosts reach the same cache through `bin/craft`
at the repository root, forwarding to `integrations/shared/craft-cli.sh`, the POSIX entry carrying the plugin version (release-please moves it): it runs
`~/.craft/bin/<version>/craft`, first downloading the release archive and its `.sha256` with `curl` or `wget` and
checking it with `sha256sum` or `shasum` when the cache lacks it (no Windows), `CRAFT_BIN` naming a local build,
and `CRAFT_ROOT` defaulting to the plugin root. The download itself is `integrations/shared/craft-fetch.sh` with `integrations/shared/craft-fetch-http.sh` — the release URL, the REST API fallback, the SHA-256,
the lock and the cache layout in one place —, which `craft-cli.sh` sources (`--ensure` only fetches;
`--ensure --print-path` also prints the executable path, used by the `review` engine and by `review-init`, `develop` and `addressing-findings` even in packages without `bin/`) and `integrations/shared/craft-bin.mjs ensure`
runs (its own Node download kept for Windows only). `integrations/shared/craft-hook.sh <name>`
runs the start, prompt, subagent and reviewer-dispatch hooks as `craft hook <name>` from the same cache, never waiting for
a download: while the binary is absent it makes the repo test itself (`integrations/shared/craft-hook-repo.sh`) and, where the repo has
role signs and the switch is on, the start fetches it in the background and says so (`integrations/shared/craft-hook-absent.sh`; release-please
moves its version too). The OpenCode work hook runs `craft hook opencode-message` the same way. `integrations/shared/pr-opened-hook.sh`, the PostToolUse hook on the Bash tool (Claude Code;
Codex: unobserved), hands a call that says `pr create` or `pr new` and prints a pull request's numbered URL to `craft hook pr-opened` — the cached binary of
its own version (release-please moves it), never downloaded. When the command said `pr create` or `pr new` and printed
a PR's URL, the binary asks `gh pr view` for the PR's head and base and warns when the run store holds no finished
full `craft:review` of that head and the PR's whole change, and says when it could not check.

## Codex delivery

`.codex-plugin/plugin.json` and the marketplace `.agents/plugins/marketplace.json` deliver the same
`skills/` and hooks file (`integrations/claude-code/hooks/hooks.json`, named by the manifest's `hooks`) to the
Codex CLI. Its plugin root is the repository root: Codex leaves symlinks out of the copy it installs
(`integrations/codex/README.md`). Codex has no Workflow tool, so `rust-audit`, `triage-findings` and
craft:develop's loop do not run there. The review, new and not yet observed running in a real Codex session: the
`codex-review` skill has the session run `bin/craft review run --backend codex`, the `craft` binary's own driver, which
runs each task as its own `codex exec --ephemeral -s read-only` process, with the prompt body of the craft agent the
task names (`integrations/claude-code/agents/`) before the task's prompt.

## Dev shell

`flake.nix` gives `nix develop` (and direnv, through `.envrc`) the CLI's pinned toolchain from
`cli/rust-toolchain.toml` with rust-analyzer, Node 22, a C linker for the build scripts, `cargo mutants`, `jq` and
`nixfmt`, its formatter. CI installs its own tools and does not read it.

## Layout

```
craft/
├── .claude-plugin/
│   └── marketplace.json   # single-plugin marketplace (source: the claude-code-plugin branch)
├── .codex-plugin/plugin.json      # the Codex plugin manifest (root skills/ and integrations/shared/, the Claude Code hooks file)
├── .agents/plugins/marketplace.json  # the Codex marketplace (source: .)
├── integrations/          # one directory per harness craft is delivered to
│   ├── claude-code/       # the Claude Code plugin (what a marketplace install copies)
│   │   ├── .claude-plugin/plugin.json   # plugin metadata
│   │   ├── agents/        # diff/structure review agents and the engines' service agent
│   │   ├── hooks/hooks.json   # SessionStart, UserPromptSubmit, SubagentStart, PreToolUse (integrations/shared/craft-hook.sh: `craft hook <name>`); PostToolUse (integrations/shared/pr-opened-hook.sh)
│   │   ├── workflows/     # multi-agent orchestration scripts, generated from integrations/claude-code/src/ (npm run build:engines)
│   │   ├── src/           # authored engines; packaged only at integrations/claude-code/src
│   │   ├── integrations/  # finite projections: shared and claude-code/src
│   │   └── skills, content, README.md -> ../../…   # release branch dereferences these links
│   ├── shared/           # tested helpers and hooks; config/ tools, fixtures/semgrep/ examples
│   ├── opencode/          # the OpenCode adapter layer (agents, commands, plugin, install.sh)
│   ├── codex/             # where the Codex delivery lives, and why its manifest stays at the root
│   └── pi/                # the pi package's craft-review skill; its craft_review tool is integrations/pi/pi-extension.mjs (new)
├── bin/craft              # the sh wrapper Codex, pi and OpenCode run the craft binary of this version through
├── content/               # prompts and schemas the engines and the CLI render
├── cli/                   # the craft Rust CLI
└── skills/                # (abbreviated)
    ├── rust-review/
    ├── rust-testing/
    └── …
```

## Deliveries

`integrations/` holds all tracked JavaScript and TypeScript: one directory per harness and `shared/` for cross-host modules.
`integrations/shared/config/` holds the five JS tool configs, `fixtures/semgrep/` the rule examples;
`layout-paths.mjs` reconciles known historical paths for floor and quality comparisons, `check-js-boundary.mjs`
holds the tracked-file boundary, and `audit-count.mjs` summarizes CI's development-dependency audit. `integrations/claude-code/` is the Claude Code plugin: its
manifest, `agents/`, `hooks/` and the built `workflows/`, with `skills`, `content` and `README.md` as
symlinks to the shared ones at the root; nested `integrations/shared` and `integrations/claude-code/src`
project the shared modules and authored engines at their canonical paths. The package omits the checkout-only
top-level `src`, so each engine source has one packaged home; a load in place (`--plugin-dir`) follows them into the checkout. The root
marketplace (`.claude-plugin/marketplace.json`) installs it from the `claude-code-plugin` branch (a `url` source over
HTTPS), which each release rebuilds from this directory with the links dereferenced into real files
(`integrations/shared/materialize-claude-code.mjs`, run by `.github/workflows/claude-code-plugin.yml`, which release-please calls),
so a clone without symlinks (Windows) installs it whole: on Linux with `core.symlinks=false` (the Windows default)
the plugin installs with all its files. It has not been observed on Windows, where the hooks are POSIX shell
commands run by Claude Code's shell; the released binary covers x86_64 Windows too
(`craft-x86_64-pc-windows-msvc.tar.gz`, unpacked with the system's `tar.exe`), built by the release but not yet
run there. Working from a checkout, `claude --plugin-dir integrations/claude-code` loads the delivery in place
through its symlinks (Linux, macOS). `integrations/opencode/` is the OpenCode adapter; on 2.x it
installs as a package from the `opencode-plugin` branch, each release's commit tagged `opencode-v<version>`
(`integrations/shared/opencode-package.mjs` lays it out with its own `package.json`, no scripts and no dependencies — it refuses a
shipped module that imports an npm package at run time —, `integrations/shared/materialize-opencode.mjs` commits
and tags it, run by `.github/workflows/opencode-plugin.yml`, which release-please calls); `integrations/codex/` explains the
Codex delivery's place at the root, and `integrations/pi/` holds the pi package's `craft-review` skill: the repository is a pi
package whose manifest, the root `package.json`'s `pi` key, loads that
skill and one extension, `integrations/pi/pi-extension.mjs`, whose `craft_review` tool runs `bin/craft review run --backend pi
--events json` (`integrations/shared/craft-review-run.mjs`, shared with the OpenCode tool), streams its progress and draws the verdict,
findings and report — new, seen running end to end from a checkout, not yet as an installed pi package.
The pi package installs at the release tag:

<!-- x-release-please-start-version -->
```sh
pi install git:github.com/gurinderu/craft@v0.60.0
```
<!-- x-release-please-end -->
