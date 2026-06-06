# craft

Personal Claude Code collection of opinionated, self-contained engineering skills and agents.

Every skill is **self-contained** — it does not depend on any other plugin (no
`rust-skills`/`superpowers` references). The goal is full ownership of the knowledge.

## Contents

| Kind | Name | What it does |
|---|---|---|
| skill | `craft:rust-testing` | Testing Rust — unit, integration, async, `rstest`, `proptest`, `cargo-fuzz`, `cargo-mutants`, `mockall`, `insta`, doc tests, coverage, runner, CI |
| skill | `craft:rust-errors` | Error handling — `Result`/`Option`/panic decision, domain failures vs defects, `thiserror` vs `anyhow`, recovery (retry, fallback, circuit breaker) |
| skill | `craft:rust-ownership` | Ownership, borrowing, lifetimes, smart pointers — the model plus concrete fixes for borrow-checker errors (E0382/E0499/E0502/E0597/…) |
| skill | `craft:rust-concurrency` | Threads vs async, `Send`/`Sync`, `Arc`/`Mutex`/`RwLock`, channels, tokio tasks, lock-across-await, deadlocks |
| skill | `craft:rust-traits` | Traits, generics, dispatch (static / `dyn` / enum), object safety, type-driven design (newtype, typestate, `PhantomData`, sealed) |
| skill | `craft:rust-performance` | Measure-first perf — criterion/divan, profiling, build config, heap allocations, hashing, type sizes, iterators |
| skill | `craft:rust-architecture` | Hexagonal (ports & adapters) — domain core, ports as traits, adapters, dependency inversion, domain modeling, module layout |
| skill | `craft:rust-idioms` | Idiomatic Rust — naming conventions, native constructs, clippy/rustfmt, rustdoc conventions, and an anti-pattern catalog (Good/Bad) |
| skill | `craft:rust-unsafe` | Unsafe done soundly — the five superpowers, `// SAFETY:` discipline, UB, raw pointers, FFI, `#[repr]`, Miri |
| skill | `craft:rust-ecosystem` | Crates & Cargo — choosing deps, features/workspaces, edition/MSRV, project layout, publishing (semver, docs, interop) |
| skill | `craft:rust-review` | Code-review rubric — cargo gate, severity checklist, Approve/Warning/Block verdict |
| skill | `craft:rust-web` | Web services with axum/tokio/tower/sqlx — routing, extractors, state, errors, db pool, middleware, shutdown, auth (JWT/argon2), OpenAPI (utoipa) |
| skill | `craft:rust-cli` | CLI & TUI — clap (args/subcommands/config), output/exit-code conventions, and full-screen apps with ratatui |
| skill | `craft:rust-security` | Security review — cargo-audit/deny/geiger + semgrep: vulns, supply chain, unsafe surface, taint/custom rules |
| skill | `craft:rust-plugins` | Plugin systems — trait-objects/scripting/RPC/WASM/cdylib chosen by trust; FFI+abi_stable, wasmtime/extism |
| skill | `craft:rust-macros` | Metaprogramming — macro_rules! and proc macros (derive/attribute/function-like) with syn/quote, cargo-expand, trybuild |
| skill | `craft:rust-fintech` | Money in Rust — exact decimal, `Money`+currency, rounding/allocation, idempotency, double-entry ledgers |
| skill | `craft:rust-cloud-native` | Services — gRPC (tonic), tracing/OpenTelemetry, health probes, 12-factor config, graceful shutdown, lean containers |
| skill | `craft:specs` | Specification by example / BDD / ATDD — requirements → Given/When/Then scenarios, outside-in (language-agnostic) |
| skill | `craft:debugging` | Systematic debugging — root cause before fix; repro shrinking, bisection, instrumentation, heisenbugs (language-agnostic) |
| skill | `craft:refactoring` | Disciplined refactoring — structure-not-behavior in tiny steps under green tests (language-agnostic) |
| skill | `craft:verification` | Evidence before claims — run the proving command and read it before saying done (language-agnostic) |
| skill | `craft:requesting-review` | Request review with a crafted brief, early/often; dispatch the review agents; act on the verdict (language-agnostic) |
| skill | `craft:receiving-review` | Act on review feedback technically — verify-before-implement, no performative agreement, reasoned pushback (language-agnostic) |
| skill | `craft:codebase-onboarding` | Understand an unfamiliar codebase first — map, find seams, trace one flow, confirm by building (language-agnostic) |
| agent | `rust-reviewer` | Runs the gate, reviews a diff against the `rust-review` rubric, returns a verdict |
| agent | `rust-security-scanner` | Runs the security toolchain, consolidates findings, returns a verdict |
| agent | `rust-miri` | Runs unsafe code under Miri to detect undefined behavior |
| workflow | `rust-audit` | Runs `rust-reviewer` + `rust-architecture-reviewer` + `rust-security-scanner` + `rust-miri` (if `unsafe` present) in parallel and synthesizes one severity-ranked report |

## Layout

```
craft/
├── .claude-plugin/
│   ├── plugin.json        # plugin metadata
│   └── marketplace.json   # single-plugin marketplace (source: ./)
├── agents/                # (abbreviated)
│   ├── rust-reviewer.md
│   ├── rust-security-scanner.md
│   └── rust-miri.md
├── workflows/             # multi-agent orchestration scripts
│   └── rust-audit.js
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

## Workflows

`workflows/rust-audit.js` orchestrates the review agents in one pass: a scout step detects
the diff base and whether the workspace has `unsafe`, then `rust-reviewer`,
`rust-architecture-reviewer`, `rust-security-scanner`, and (only if `unsafe` is present)
`rust-miri` run in parallel, and a final step synthesizes one severity-ranked report.

Run it against a path or fixed diff base:

```
Workflow({ scriptPath: "workflows/rust-audit.js", args: { base: "origin/main" } })
```

`args.base` is optional — without it the scout falls back to
`merge-base HEAD origin/main` → `main` → `HEAD~1`.

## Conventions

- Skills use progressive disclosure: a lean `SKILL.md` entry plus sub-files loaded on demand.
- Crate versions in examples track the latest stable release; `edition = "2024"`.
- Skills may reference **each other** (e.g. `rust-review` points at `rust-testing` for how to
  write missing tests) but never an external plugin.
