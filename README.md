# craft

Personal Claude Code collection of opinionated engineering skills and agents.

craft owns its **Rust** and **Nix** knowledge in full and is **self-contained** — it declares no
plugin dependencies and carries no generic engineering-process content. Language-agnostic
*discipline* (how to run a review, how to verify a claim, the debugging method) is intentionally
out of scope; bring your own process skills. craft's skills cross-reference **each other** — that
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
| skill | `craft:addressing-findings` | The fix loop for review findings — gather (craft agents + GitHub PR comments), normalize, triage (accept/reject/defer/needs-decision/conflict), order, fix (delegating how-to-fix to topic skills), verify, re-review, close the GitHub loop; scales to the `triage-findings` workflow |
| agent | `rust-reviewer` | Per-lens worker for the `review` workflow's rust profile; run directly for an ad-hoc whole-diff Rust review (establishes the CI-aware gate and returns a verdict) |
| agent | `nix-reviewer` | Per-lens worker for the `review` workflow's nix profile; run directly for an ad-hoc whole-diff Nix review (nix flake check / statix / deadnix gate + verdict) |
| agent | `rust-security-scanner` | Runs the security toolchain, consolidates findings, returns a verdict |
| agent | `rust-miri` | Runs unsafe code under Miri to detect undefined behavior |
| agent | `rust-architecture-reviewer` | Audits the whole-project structure against the `rust-architecture-review` rubric, returns a Healthy/Concerns/At-risk rating |
| workflow | `review` | **Default diff-review path.** Auto-detects the language(s) in the diff (Rust/Nix), runs each language's gate + scout-scaled lens fan-out (loop-until-dry, adversarial + self-verification), and merges into one Confirmed/Suspected report + verdict |
| workflow | `rust-review` / `nix-review` | Thin pins over `review` that force a single language (`workflow('review', {languages:['rust'\|'nix']})`) |
| workflow | `rust-audit` | Full crate audit — per-crate review, inter-crate contracts, architecture, crate-decomposition, security, Miri, semver, build-matrix, deps, unused-crate detection (verified), and test/doc health, run in parallel and synthesized into one report |
| workflow | `triage-findings` | Validates review findings (craft agents + GitHub PR comments) in parallel, dedups/conflict-checks, and renders one ordered fix plan (checkbox-task format) + a triage ledger — no edits |

## Layout

```
craft/
├── .claude-plugin/
│   ├── plugin.json        # plugin metadata
│   └── marketplace.json   # single-plugin marketplace (source: ./)
├── agents/                # diff/structure review agents
│   ├── rust-reviewer.md
│   ├── rust-security-scanner.md
│   ├── rust-miri.md
│   └── rust-architecture-reviewer.md
├── workflows/             # multi-agent orchestration scripts
│   ├── rust-review.js
│   ├── rust-audit.js
│   └── triage-findings.js
├── lib/                   # tested helpers shared (inlined) by the workflows
│   └── run-record.mjs
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

## opencode

craft also runs in [opencode](https://opencode.ai) via a contained adapter layer under
`opencode/`: the skills are shared verbatim (opencode reads the Anthropic skill spec), the 4
review agents are translated to opencode agent files, and the `rust-audit` / `triage-findings`
workflows ship as one contained TS/Bun plugin (`/rust-audit`, `/triage-findings`). Install with
`opencode/install.sh` (project-scoped by default). See `opencode/README.md` for details, the model
strategy, and parity caveats.

## Workflows

`workflows/review.js` is the default diff-review path and the generic engine: it **auto-detects the
language(s)** in the diff via an inline `PROFILES` registry (Rust and Nix built in), and for each
active language a scout sizes the diff and picks lenses + rigor, lenses fan out in parallel and loop
until dry, every finding is adversarially and self-verified, and a synthesis step merges everything
into one Confirmed/Suspected report with a verdict — depth scales to the diff automatically.
`workflows/rust-review.js` and `workflows/nix-review.js` are thin pins that force a single language.

`workflows/rust-audit.js` is the full pre-release audit: a scout detects the diff base, `unsafe`,
the workspace crates and their dependency edges, then many dimensions run in parallel — per-crate
review, inter-crate contracts, architecture, crate-decomposition, security, Miri (if `unsafe`),
semver, build-matrix, deps, unused-crate detection (with verification), and test/doc health — and
a final step synthesizes one severity-ranked report.

`workflows/triage-findings.js` validates findings (craft agents + GitHub PR comments), dedups and
conflict-checks them, and renders one ordered fix plan + a triage ledger — no edits.

Both review workflows and the standalone agents emit a structured run record after each run; see
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
