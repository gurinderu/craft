# craft — collection map

The plan for `craft`: an opinionated set of engineering skills that fully own craft's **Rust**
knowledge and **build on the `superpowers` plugin** (a declared dependency) for the generic
engineering-process discipline. It replaces `rust-skills` entirely.

## Principles

1. **Own the Rust knowledge; delegate generic process to superpowers.** No craft skill
   duplicates a `superpowers` skill — the language-agnostic method (systematic debugging,
   verification-before-completion, requesting/receiving code review) lives in `superpowers` and
   craft skills point at it. `superpowers` is a declared plugin dependency, so installing craft
   pulls it in. Skills also reference *each other* — that cross-linking is the collection's
   cohesion.
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

## Rust skill set

Status: ✅ done

| Skill | Status | Scope | Does NOT cover (owner) |
|---|---|---|---|
| `rust-testing` | ✅ | unit/integration/doc, async, rstest, proptest, cargo-fuzz, cargo-mutants, mockall, insta, testcontainers, coverage, runner, CI | benchmarks → `rust-performance` |
| `rust-review` | ✅ | cargo gate, severity checklist, verdict; **public-API design pass** (Rust API Guidelines checklist → `api-design.md`); requesting a craft review (agent dispatch + crafted brief); the Rust "what proves what" verification table | *how* to fix → topic skills; *how* to test → `rust-testing`; generic review/verify discipline → `superpowers` |
| `rust-errors` | ✅ | `Result`/`Option`, `?`, domain failures vs defects (ZIO model), thiserror vs anyhow, library-vs-app design, recovery/retry/circuit-breaker | panics as control flow → `rust-idioms` |
| `rust-ownership` | ✅ | borrowing, lifetimes, `Cow`, smart pointers (`Box`/`Rc`/`Arc`), interior mutability (`Cell`/`RefCell`); fixes for E0382/E0597/E0499/E0502 | cross-thread sharing/`Send`+`Sync` → `rust-concurrency` |
| `rust-concurrency` | ✅ | threads vs async, `Send`/`Sync`, `Arc<Mutex>`, channels, tokio, deadlocks, lock-across-await | single-thread `Rc`/`RefCell` → `rust-ownership` |
| `rust-traits` | ✅ | generics, trait bounds, static vs dynamic vs **enum dispatch**, object safety, type-driven design (newtype, typestate, `PhantomData`, sealed) | lifetimes mechanics → `rust-ownership` |
| `rust-performance` | ✅ | measure-first, criterion/divan benchmarks, profiling, build config (LTO/codegen-units/target-cpu), PGO, heap allocs (arenas, compact strings), hashing, type sizes, iterators, safe SIMD/autovectorization, inlining & code layout (`#[cold]`) | correctness tests → `rust-testing`; `get_unchecked` / arch-specific SIMD intrinsics → `rust-unsafe` |
| `rust-unsafe` | ✅ | `unsafe`, raw pointers, FFI, `// SAFETY:` invariants, `#[repr]` layout, UB, Miri | safe abstractions → `rust-ownership` |
| `rust-idioms` | ✅ | idiomatic style, naming, clippy lints, rustdoc conventions, anti-patterns & common mistakes (catalog of Good/Bad) | the review *process* → `rust-review`; publish-doc/semver → `rust-ecosystem` |
| `rust-ecosystem` | ✅ | crate selection, `Cargo.toml`/deps, features, workspaces, edition/MSRV, project layout, publishing (semver/docs), build.rs, no_std, cross-compilation | build profiles → `rust-performance`; naming → `rust-idioms` |
| `rust-architecture` | ✅ | hexagonal / ports & adapters: domain core, ports as traits, adapters, dependency inversion, domain modeling, module layout, CQRS & event sourcing | dispatch → `rust-traits`; domain errors → `rust-errors`; port mocks → `rust-testing` |
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

Other domains (ML, IoT, gamedev, …) and live-data tooling (docs lookup, crate research) remain
open backlog.

## Agents

Tool-runner agents (run tools → interpret → report a verdict, in their own context). Each pairs
with a skill for the rubric and degrades gracefully when a tool is absent.

| Agent | Runs | Rubric skill |
|---|---|---|
| `rust-reviewer` | per-lens diff review for the `rust-review` workflow; run directly = ad-hoc whole-diff review that establishes the CI-aware gate and returns a verdict | `rust-review` |
| `rust-architecture-reviewer` | whole crate/module dependency graph audit | `rust-architecture-review` |
| `rust-security-scanner` | cargo-audit/deny/geiger + semgrep | `rust-security` |
| `rust-miri` | `cargo +nightly miri test` (UB) | `rust-unsafe` |

clippy/test/coverage stay as commands inside `rust-reviewer` / the testing tooling — not separate
agents (would duplicate).

## Workflows

Multi-agent orchestration scripts under `workflows/` that compose the agents above (referencing
them by `agentType` — internal to the plugin, no external dependency).

| Workflow | Composes | Output |
|---|---|---|
| `rust-review` | scout-scaled lens fan-out → `rust-reviewer` (per lens) → loop-until-dry → adversarial + self-verification | Confirmed/Suspected finding report (elastic deep review engine; `rust-reviewer` is its per-lens worker) |
| `rust-audit` | per-crate review + inter-crate contracts + architecture + crate-decomposition + security + miri + semver + build-matrix + deps + unused-crates (verified) + tests-cov (parallel) | one synthesized severity-ranked report |
| `triage-findings` | gather → validate (parallel, per finding) → plan (barrier) | one ordered fix plan (writing-plans format) + triage ledger; no edits |

## Documentation

- `docs/observability.md` — run-record store (`~/.craft/runs/`) emitted by the `rust-review` / `rust-audit` / `triage-findings` workflows and the review agents.

## Cross-cutting skills (language-agnostic)

| Skill | Status | Scope | Does NOT cover (owner) |
|---|---|---|---|
| `specs` | ✅ | specification by example / BDD / ATDD: requirements → Given/When/Then scenarios, choosing examples, outside-in | *running* scenarios / frameworks → per-language testing skill (`rust-testing` → cucumber) |
| `debugging` | ✅ | **Rust** debugging toolbox: minimal repro, `git bisect`/`cargo bisect-rustc`, `dbg!`/`tracing`/`RUST_BACKTRACE`, Miri/loom heisenbugs, `rust-gdb`/`rr` | the method (root cause before fix) → `superpowers:systematic-debugging`; confirming the fix → `superpowers:verification-before-completion`; Rust specifics → `rust-errors`/`rust-concurrency`/`rust-unsafe` |
| `refactoring` | ✅ | structure-not-behavior in tiny steps under green tests; characterization tests; named transformations | safety net → `rust-testing`/`specs`; smell catalog → `rust-idioms` |
| `codebase-onboarding` | ✅ | understand an unfamiliar repo first: map structure, find entry points/seams, trace one flow, confirm by building | changing it → `refactoring`/`rust-architecture`; bugs → `debugging` |
| `addressing-findings` | ✅ | the fix loop for review findings: gather (craft agents + GitHub PR comments) → normalize → triage (accept/reject/defer/needs-decision/conflict) → order → fix → verify → re-review → close the GitHub loop; scales to the `triage-findings` workflow | the review *rubric* → `rust-review`; *running* the agents → `rust-audit`; generic feedback method → `superpowers:receiving-code-review`; *how* to fix → topic skills |

> **Delegated to `superpowers`** (a declared plugin dependency): the generic engineering-process
> method — `systematic-debugging`, `verification-before-completion`, `requesting-code-review`,
> `receiving-code-review`. craft formerly carried its own copies (`debugging`, `verification`,
> `requesting-review`, `receiving-review`); the duplicate method was removed and only the
> Rust-specific surface kept — `debugging`'s `techniques.md` toolbox, plus the cargo "what proves
> what" table and craft-agent dispatch folded into `rust-review`.

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
action-first stance), `domain-*` beyond web/cli/fintech/cloud-native/embedded (ML, IoT), and the
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
| m14, domain-* (ML/IoT), live-data/news agents | deferred |

## opencode adapter

`opencode/` is a thin, contained adapter layer that makes the collection usable from opencode
(skills shared verbatim by symlink; 4 translated agent files; a TS/Bun plugin hosting the
`rust-audit` and `triage-findings` workflows; a symlink `install.sh`). Single source of truth: the
skills are not duplicated. See the design spec
`docs/superpowers/specs/2026-06-17-craft-opencode-support-design.md`.
