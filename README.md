# craft

Personal Claude Code collection of opinionated engineering skills and agents.

craft owns its **Rust** and **Nix** knowledge in full and is **self-contained** — it declares no
plugin dependencies and carries no generic engineering-process content. Language-agnostic
*discipline* (how to run a review, how to verify a claim, the debugging method) is intentionally
out of scope; bring your own process skills. The one cycle craft runs — `craft:develop`, up to a
PR — uses only craft's own tools (memory, review, triage, the fix loop) and yields every phase to
the process your project declares. craft's skills cross-reference **each other** — that
cross-linking is the collection's cohesion.

## Contents

| Kind | Name | What it does |
|---|---|---|
| skill | `craft:rust-testing` | Testing Rust — unit, integration, async, `rstest`, `proptest`, `cargo-fuzz`, `cargo-mutants`, `mockall`, `insta`, doc tests, coverage, runner, CI |
| skill | `craft:rust-errors` | Error handling — `Result`/`Option`/panic decision, domain failures vs defects, `thiserror` vs `anyhow`, recovery (retry, fallback, circuit breaker) |
| skill | `craft:rust-ownership` | Ownership, borrowing, lifetimes, smart pointers — the model plus concrete fixes for borrow-checker errors (E0382/E0499/E0502/E0597/…) |
| skill | `craft:rust-concurrency` | Threads vs async, `Send`/`Sync`, `Arc`/`Mutex`/`RwLock`, channels, tokio tasks, lock-across-await, deadlocks |
| skill | `craft:rust-traits` | Traits, generics, dispatch (static / `dyn` / enum), object safety, type-driven design (newtype, typestate, `PhantomData`, sealed) |
| skill | `craft:rust-performance` | Measure-first perf — criterion/divan, profiling, build config, PGO, heap allocations (incl. arenas, compact strings), hashing, type sizes, iterators, SIMD/autovectorization, code layout |
| skill | `craft:rust-architecture` | Hexagonal (ports & adapters) — domain core, ports as traits, adapters, dependency inversion, domain modeling, module layout |
| skill | `craft:rust-architecture-review` | Architecture-audit rubric — whole-project dependency graph, severity-tiered checklist (cycles, layer leaks, god modules) AND over-engineering, Healthy/Concerns/At-risk rating |
| skill | `craft:rust-idioms` | Idiomatic Rust — naming conventions, native constructs, clippy/rustfmt, rustdoc conventions, and an anti-pattern catalog (Good/Bad) |
| skill | `craft:rust-unsafe` | Unsafe done soundly — the five superpowers, `// SAFETY:` discipline, UB, raw pointers, FFI, `#[repr]`, Miri |
| skill | `craft:rust-ecosystem` | Crates & Cargo — choosing deps, features/workspaces, edition/MSRV, project layout, publishing (semver, docs, interop) |
| skill | `craft:rust-review` | Code-review rubric — cargo gate, severity checklist, public-API design pass (Rust API Guidelines), Approve/Warning/Block verdict; requesting a craft review (agent dispatch + crafted brief); the Rust "what proves what" verification table |
| skill | `craft:rust-web` | Web services with axum/tokio/tower/sqlx — routing, extractors, state, errors, db pool, middleware, shutdown, auth (JWT/argon2), OpenAPI (utoipa) |
| skill | `craft:rust-cli` | CLI & TUI — clap (args/subcommands/config), output/exit-code conventions, and full-screen apps with ratatui |
| skill | `craft:rust-security` | Security review — cargo-audit/deny/geiger + semgrep: vulns, supply chain, unsafe surface, taint/custom rules |
| skill | `craft:rust-plugins` | Plugin systems — trait-objects/scripting/RPC/WASM/cdylib chosen by trust; FFI+abi_stable, wasmtime/extism |
| skill | `craft:rust-macros` | Metaprogramming — macro_rules! and proc macros (derive/attribute/function-like) with syn/quote, cargo-expand, trybuild |
| skill | `craft:rust-fintech` | Money in Rust — exact decimal, `Money`+currency, rounding/allocation, idempotency, double-entry ledgers |
| skill | `craft:rust-cloud-native` | Services — gRPC (tonic), tracing/OpenTelemetry, health probes, 12-factor config, graceful shutdown, lean containers |
| skill | `craft:rust-embedded` | Bare-metal/MCU `no_std` — heapless, peripheral-ownership singletons, embedded-hal drivers, ISR-safe sharing (critical-section), RTIC vs Embassy, defmt/probe-rs |
| skill | `craft:rust-navigation` | Navigate a crate with rust-analyzer over LSP — go-to-definition, find-references (impact before a rename), hover, file/workspace symbols, trait implementors, call hierarchy; text-tool fallbacks when no LSP |
| skill | `craft:specs` | Specification by example / BDD / ATDD — requirements → Given/When/Then scenarios, outside-in (language-agnostic) |
| skill | `craft:debugging` | Rust debugging toolbox — repro shrinking, `git bisect`/`cargo bisect-rustc`, `dbg!`/`tracing`/`RUST_BACKTRACE`, Miri/loom heisenbugs, `rust-gdb`/`rr` |
| skill | `craft:refactoring` | Disciplined refactoring — structure-not-behavior in tiny steps under green tests (language-agnostic) |
| skill | `craft:codebase-onboarding` | Understand an unfamiliar codebase first — map, find seams, trace one flow, confirm by building (language-agnostic) |
| skill | `craft:distributed-races` | Controller / reconcile-loop correctness, any language — self-triggering status writes, wake source for every requeue outcome, another controller's stale cache, RBAC for new verbs, protection lifetime, migration window, retry bounds on error paths, resourceVersion and UID fences; read by the review workflow's `reconciler` lens |
| skill | `craft:compatibility` | Backward compatibility, any language — old data under a new shape, rolling deploy in both directions, migrations, read-only aliases, CLI/config/env/Helm contract and defaults, CRD/API version lifecycle, proto/OpenAPI breaks, rollout order across components, renamed exported names, regression vs last release; read by the review workflow's `compat` lens |
| skill | `craft:review-rules` | Language-independent review rules — severity capped by the harm a finding names, finding classes, the sibling sweep and other search moves, shared exclusions; read by every review lens and verifier beside the language rubric |
| skill | `craft:memory` | Semantic memory of the project's own facts — decisions on findings, project rules on classes of findings, lessons, open questions — `recall` / `record-decision` / `record-rule` / `record-lesson` / `record-question` over whatever store the project has (explicit setting, a memory MCP server found by capability, the harness's project memory, or `.craft/memory/` files); not craft's run records |
| skill | `craft:review-init` | `craft init` for the CLI review: your own profile of a repository, kept outside it in `~/.craft/projects/<id>/review.toml` — the integration points (the external systems the code talks to over the network or through their API), each with its source URL and deployed tag or commit; the review fetches each source at that revision into `~/.craft/sources`, and its lifecycle, compatibility and race lenses and its verifiers read it; and the CI map, the checks whose result the gate reads for the head when it cannot build the branch itself — a red one blocks, a green one is reported, never a pass |
| skill | `craft:addressing-findings` | The fix loop for review findings — gather (craft agents + GitHub PR comments), normalize, triage (accept/reject/defer/needs-decision/conflict), order, fix (delegating how-to-fix to topic skills), verify, re-review, close the GitHub loop; triage always goes through the `triage-findings` workflow |
| skill | `craft:develop` | The development cycle up to a PR with craft's own tools — the project's declared roles and rules take any phase they cover; recall project memory, make the change, review → triage → fix — the first round over the branch diff, each next over the delta the fixes changed — until a round brings no open Medium+ finding (at most 4 rounds, then stop and tell the human), one full review, one record of the cycle in the run store, then the PR; runs in the main session |
| agent | `rust-reviewer` | Per-lens worker for the `review` workflow's rust profile; run directly for an ad-hoc whole-diff Rust review (runs the gate itself — a CI check only informs — and returns a verdict, at most Warning when the gate could not be established) |
| agent | `nix-reviewer` | Per-lens worker for the `review` workflow's nix profile; run directly for an ad-hoc whole-diff Nix review (nix flake check / statix / deadnix gate + verdict) |
| agent | `rust-security-scanner` | Runs the security toolchain, consolidates findings, returns a verdict |
| agent | `rust-miri` | Runs unsafe code under Miri to detect undefined behavior |
| agent | `engine-service` | Runs the engines' service steps (the review's `craft review` calls, checkpoints, the run record) exactly as their prompts say; defined with `omitClaudeMd: true`, so that it is not handed the project's instructions; launched by the engines, not by hand |
| agent | `rust-architecture-reviewer` | Audits the whole-project structure against the `rust-architecture-review` rubric, returns a Healthy/Concerns/At-risk rating |
| hook | `SessionStart` (Claude Code) | When the repo declares its own agents (`.claude/agents/*.md`) or work rules (an `AGENTS.md` / `CLAUDE.md` that names the process: pull request, PR, code review, reviewer, review loop, before merging), adds four lines of context: the repo's roles and rules win on every step they cover, whichever declared role develops there runs its cycle with craft's tools (`craft:memory` before the work, `craft:develop`'s review loop before a PR), and a role running as a subagent hands the review loop back to the main session. Silent otherwise; off with `CRAFT_ROLE_HOOK=0` or a `craft-role-hook: off` line in `AGENTS.md` / `CLAUDE.md`. Each run appends one line to `~/.craft/hooks.jsonl` (spoke or why silent; rotated past 256 KiB), which `lib/analyze-runs.mjs` reports beside the review runs made after it first spoke in their repo |
| hook | `UserPromptSubmit`, `SubagentStart` (Claude Code) | In the same repos and with the same off switch: on a message that asks for review work — English words such as review, findings, PR comments, pull request, merge request, a PR or MR link, or a comment or fix word beside a PR word ("check the PR for new comments") — adds its lines (eight for findings, five for a review) once per session for each kind of request (again after a compact or clear). A message written mostly in another script than Latin (Russian, Greek, Chinese…) gets one conditional text instead, the first in a session (again after a compact or clear), standing for that and every later request in the session and letting the model decide whether one asks for findings work or a review; each later such message gets one reminder line that those lines apply to it if it is about findings, PR comments or a review. The conditional text and the per-kind texts do not stand in for each other: an English request after it still gets its kind's lines, and a non-Latin one after them still gets the conditional text. It answers only a human's word: a subagent's report or a task notification the harness hands back as a prompt gets nothing, except one conditional line (if the report completes the fixes, re-review before posting replies) on the first subagent report in a session that heard the findings lines, again only after a compact or clear; a bare English "continue" ("keep going", "finish it") takes the kind of the session's latest prompt (none if that one asked for something else), or, as a session's first prompt, of the repo's latest prompt from another session within 12 hours; prompts it leaves unclassed are logged as `no-kind` for that. For findings: one call before the first tool call, `craft:addressing-findings`; right after it, the `craft:memory` recall for every path the findings touch, before triage; after the fixes are in and before any reply is posted, the re-review in the main session (the `craft:review` workflow on any language: Rust and Nix under their profiles, other source under its general lenses, in one run) until no Medium-or-higher finding is open; what the skill gives over working by hand; the main session holds the memory — it puts the records `craft:memory` recalls into each subagent's brief and records every triage disposition itself, right after triage (checking the `memory backend:` line); triage, whatever the number of findings, is the `craft:triage-findings` workflow launched in the main session (`report` = the findings written to a file whenever they live in a report, `pr` whenever there is a PR, at least one, and `prBase` with `base` = the reviewed head's SHA only when the reviewed head is a branch diverging from trunk — on trunk or with no branch `prBase` is left out and the findings claimed not this PR's go to the human), never handed to a subagent, and the main session files its issues; only the fixes may be delegated, with a ready line to paste into each fixer's brief with its file group that has the fixer never re-triage nor write memory and report a planned fix it finds wrong. For a review: `craft:develop` for the loop or, for one pass, the `craft:review` workflow on any language (Rust and Nix under their profiles, other source under its general lenses, in one run), both in the main session, never handed to a subagent; the same memory line; a ready brief line for a delegated reviewer, which reports findings only, changes no code and records nothing. In that session, a subagent started with the Agent tool gets five lines of its own (triage, replies and fixes per PR comments count as findings work; triage is never its own — asked to triage, it reports that back; it fixes a plan's file group with its verdicts as given, never writes memory and reports a planned fix it finds wrong; a pure review changes and records nothing) (craft's own agents get none: a `craft:` agent, one of craft's shipped agents by its bare name, or the Workflow tool's, none of them logged). Each firing goes to `~/.craft/hooks.jsonl` with its event, counted per event in the "craft hooks" section of `lib/analyze-runs.mjs` (the re-review line and the reminder line as rows of their own) (the review-run join stays on SessionStart) |
| hook | `chat.message`, `event` (OpenCode plugin) | The same request classes, repo test and off switch over OpenCode's plugin hooks: on a message asking for review work, appends a synthetic text part (eight lines for findings — with the recall before triage, triage in the session itself with the sift done by hand (OpenCode has no sift engine; its `triage-findings` tool only validates), and the re-review before replies, its own pass or `rust-review`/`rust-audit` — five for a review) once per session for each kind of request (again after a compaction; the first message in a non-Latin script gets one conditional text covering both kinds as a standing rule for the session, each later one a reminder line, and neither stands in for the per-kind texts), shaped as the Claude Code lines but naming what the OpenCode delivery ships: `addressing-findings` for findings, `rust-review` or the `rust-audit` tool (`/rust-audit`) for a review, the `memory` skill held by the main session, and a ready brief line for a fixer (the fixes only) or a reviewer agent; a repo's own `.opencode/agents` count as declared roles, craft's installed links there do not; a subagent session hears its own five lines on its first message when its brief asks for review work or its parent heard the prompt lines; the sessions the plugin's workflows open and craft's own agents hear nothing (unlogged). Logged to `~/.craft/hooks.jsonl` as `chat.message` and `session.compacted`. OpenCode has no session-start hook here |
| workflow | `review` | **The diff review, any language.** Drives the `craft` CLI's step-by-step review: the binary sends each changed file to its profile (Rust, Nix, or the general lenses for other source), runs the mechanical gate, the scouts, the lens rounds until dry, verification and the project-memory checks, and writes one report with a verdict; a later run of the branch reviews only the fix commits since the last one. Optional: post the findings on the PR (`comment`), resume a run stopped by the usage limit (`run=`), narrow to a directory (`path=`) |
| workflow | `rust-audit` | Full crate audit — the mechanical gate once and a CLI review per crate, inter-crate contracts, architecture, crate-decomposition, security, Miri, semver, build-matrix, deps, unused-crate detection (verified), and test/doc health, run in parallel and synthesized into one report |
| workflow | `triage-findings` | Sifts review findings (craft agents + GitHub PR comments) by project memory, validates the rest in parallel, dedups/conflict-checks, and renders one ordered fix plan (checkbox-task format) + a triage ledger — no edits |

## Layout

```
craft/
├── .claude-plugin/
│   └── marketplace.json   # single-plugin marketplace (source: the claude-code-plugin branch)
├── .codex-plugin/plugin.json      # the Codex plugin manifest (root skills/ and lib/, the Claude Code hooks file)
├── .agents/plugins/marketplace.json  # the Codex marketplace (source: .)
├── integrations/          # one directory per harness craft is delivered to
│   ├── claude-code/       # the Claude Code plugin (what a marketplace install copies)
│   │   ├── .claude-plugin/plugin.json   # plugin metadata
│   │   ├── agents/        # diff/structure review agents and the engines' service agent
│   │   ├── hooks/hooks.json   # SessionStart (lib/session-start-hook.mjs); UserPromptSubmit, SubagentStart (lib/work-hook-entry.mjs); PreToolUse (lib/reviewer-dispatch-hook-entry.mjs)
│   │   ├── workflows/     # multi-agent orchestration scripts, generated from src/ (npm run build:engines)
│   │   └── skills, lib, content, src, README.md -> ../../…   # symlinks; the release branch holds them as real files
│   ├── opencode/          # the OpenCode adapter layer (agents, commands, plugin, install.sh)
│   ├── codex/             # where the Codex delivery lives, and why its manifest stays at the root
│   └── pi/                # the pi package's craft-review skill; its craft_review tool is lib/pi-extension.mjs (new)
├── src/                   # the workflow scripts as authored
├── bin/craft              # the sh wrapper Codex, pi and OpenCode run the craft binary of this version through
├── lib/                   # tested helpers shared (bundled) by the workflows; the hooks' scripts
├── content/               # prompts and schemas the engines and the CLI render
├── cli/                   # the craft Rust CLI
└── skills/                # (abbreviated)
    ├── rust-review/
    ├── rust-testing/
    └── …
```

## Install

```
/plugin marketplace add gurinderu/craft
/plugin install craft@craft
```

The marketplace installs the plugin from the `claude-code-plugin` branch (a `url` source over HTTPS), which each
release rebuilds from `integrations/claude-code` with its symlinks replaced by real files, so the install has
nothing to dereference. On Linux with `core.symlinks=false` (the Windows default) the plugin installs with all its
files. It has not been observed on Windows, where the hooks are POSIX shell commands run by Claude Code's shell. The `review` workflow's mechanical gate builds and runs the reviewed branch's code on your machine (clippy runs
its build scripts and proc macros, `nix flake check` its checks): pass `gate=false` for a branch you do not trust. Its
released binary covers x86_64 Windows too (`craft-x86_64-pc-windows-msvc.tar.gz`, unpacked with the system's
`tar.exe`), built by the release but not yet run on Windows. Working from a checkout,
`claude --plugin-dir integrations/claude-code` loads the delivery in place through its symlinks (Linux, macOS).

## opencode

craft also runs in [opencode](https://opencode.ai) via a contained adapter layer under
`integrations/opencode/`: the skills are shared verbatim (opencode reads the Anthropic skill spec), the 4
review agents are translated to opencode agent files, and the `rust-audit` / `triage-findings`
workflows ship as one contained TS/Bun plugin (`/rust-audit`, `/triage-findings`), beside `/review`, which runs the
`craft` binary's own review (`bin/craft review run --backend opencode`) on the session's model. Install with
`integrations/opencode/install.sh` from a checkout of a release tag (project-scoped by default). See `integrations/opencode/README.md` for details, the model
strategy, and parity caveats.

## Codex

craft installs into the [Codex CLI](https://github.com/openai/codex) as a plugin: `.codex-plugin/plugin.json`
and the marketplace `.agents/plugins/marketplace.json` serve the same `skills/` and hooks file
(`integrations/claude-code/hooks/hooks.json`) as the Claude Code plugin. The Codex plugin root is the repository
root (see `integrations/codex/README.md`).

<!-- x-release-please-start-version -->
```
codex plugin marketplace add gurinderu/craft --ref v0.50.1
codex plugin add craft@craft
```
<!-- x-release-please-end -->

The marketplace is pinned to the release tag because `bin/craft` runs the `craft` binary of the plugin's release
version: a marketplace that followed `main` would run newer skills and content with an older binary.

Codex runs a plugin's hooks only once you trust them: open `/hooks` in the Codex TUI and trust craft's. The
skills appear as `craft:<name>`. Codex has no Workflow tool, so the workflow engines `rust-audit` and
`triage-findings` and the review loop of `craft:develop` do not run there. The review has a Codex route, new and not
yet observed running in a real Codex session (the hooks tell a session to review the diff itself when the command
cannot run or fails): the `craft:codex-review` skill has the session run one command,
`sh <plugin root>/bin/craft review run --backend codex [flags ...]`. `bin/craft` runs the `craft` binary of the
plugin's version, downloading it from the GitHub release into `~/.craft/bin/<version>/` the first time; the binary
drives the same review as the `craft:review` workflow and runs each review task as its own
`codex exec --ephemeral -s read-only` process with the session's login — in parallel, 4 at once by default
(`--concurrency <n>`), on Codex's configured model unless `--models <model>` or
`--models opus=<m>,sonnet=<m>,haiku=<m>` (or `CRAFT_CODEX_MODELS`) names one per tier. The command writes under
`~/.craft` and starts model calls, so it runs outside Codex's sandbox. Under Codex the hooks also count the project's own agent roles (`.codex/agents/*.toml`) as declared roles.

## Workflows

`workflows/review.js` is the diff review for any language. It drives the `craft` binary (the Rust
CLI in `cli/`, fetched from this version's GitHub release unless `craftBin` names a local build), which
decides every step: each changed file goes to its profile — Rust, Nix, or the general lenses for
source in any other language — the mechanical gate runs, a scout per profile picks lenses, the lenses
loop until dry, the findings are deduplicated and verified, and the binary writes one report with a
verdict; the workflow only runs the agents each step hands out. A later run of the same branch builds
on the earlier one (reviewing the fix commits, re-judging the findings it left open) unless `fresh`.
`craft init` (the `craft:review-init` skill) writes your own profile of the repository, whose
integration points the review fetches and reads at their deployed version, and whose CI map — which
check of the project's CI runs clippy, the tests, fmt or the build, on which command line — the
gate reads for the head when it cannot build the branch itself: a red check blocks, a green one is
reported and never passes the gate.

`workflows/rust-audit.js` is the full pre-release audit: a scout detects the diff base, `unsafe`,
the workspace crates and their dependency edges, then many dimensions run in parallel — per-crate
review, inter-crate contracts, architecture, crate-decomposition, security, Miri (if `unsafe`),
semver, build-matrix, deps, unused-crate detection (with verification), and test/doc health — and
a final step synthesizes one severity-ranked report.

`workflows/triage-findings.js` gathers findings (craft agents + GitHub PR comments), sifts out what
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

Run a workflow against a path or fixed diff base:

```
Workflow({ scriptPath: "workflows/rust-audit.js", args: { base: "origin/main" } })
```

`args.base` is optional — without it the scout falls back to
`merge-base HEAD origin/main` → `main` → `HEAD~1`.

## Conventions

- Skills use progressive disclosure: a lean `SKILL.md` entry plus sub-files loaded on demand.
- Crate versions in examples track the latest stable release; `edition = "2024"`.
- Skills reference **each other** (e.g. `rust-review` points at `rust-testing` for how to write
  missing tests). Generic engineering-process discipline is out of scope — craft names no external
  process skills and declares no plugin dependencies.
