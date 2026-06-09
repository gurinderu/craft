---
name: rust-ecosystem
description: Rust ecosystem and project setup — choosing crates, Cargo.toml and dependencies, features, workspaces, editions/MSRV, project/module layout, and publishing libraries (semver, docs, interop). Use when adding a dependency, structuring a project or workspace, configuring Cargo, setting edition/MSRV, or preparing a crate to publish. Triggers: Cargo.toml, cargo add, feature flag, workspace, edition, MSRV, semver, crates.io, which crate.
---

# Rust Ecosystem & Project Setup

Choosing dependencies, wiring up Cargo, and structuring a project — the decisions around the
code rather than in it. Deep Cargo mechanics and library/publishing concerns are in the
sub-files.

## When to Use

- Adding or evaluating a dependency
- Structuring a project, workspace, or module tree
- Configuring `Cargo.toml`, features, edition, MSRV
- Preparing a library to publish (semver, docs, interop)

## Choosing a crate

A dependency is a long-term liability — vet before adding:

| Check | Why |
|---|---|
| Maintenance | recent commits/releases; open-issue responsiveness; not abandoned |
| Adoption | downloads / reverse-deps; widely-used crates are battle-tested |
| API surface & semver | post-1.0? churny pre-1.0 APIs cost you upgrades |
| Dependency weight | how many transitive deps + compile-time it drags in |
| License | compatible with yours (→ `rust-security`) |
| `unsafe` / soundness | audited? unsafe-surface scan → `rust-security` |

Prefer the ecosystem's de-facto crates (serde, tokio, clap, …) over novelty — they're
documented, supported, and what reviewers expect. Don't pull a crate for a few lines you can
write yourself; do pull one for anything security- or correctness-sensitive (crypto, parsing,
time).

## Cargo basics

```bash
cargo add serde --features derive    # edit Cargo.toml for you (cargo-edit, now built in)
cargo update                          # bump within semver ranges; updates Cargo.lock
cargo tree                            # inspect the dependency graph
cargo tree -d                         # find duplicate versions
```

Commit `Cargo.lock` for binaries (reproducible builds), not for libraries (let consumers
resolve). Dependency versions, features, and workspaces → [cargo.md](cargo.md).

## Project defaults

```toml
[package]
edition = "2024"        # latest edition; opt into new idioms
rust-version = "1.85"   # declare your MSRV so Cargo can enforce it
```

- Use the **latest edition** for new projects (editions are opt-in and per-crate; they don't
  split the ecosystem).
- Declare **MSRV** (`rust-version`) if anyone consumes your crate — and test it (`cargo-hack`,
  `cargo-msrv`).
- Turn up clippy lints (`[lints.clippy]`) → `rust-idioms`.

## Project layout

| Shape | Use |
|---|---|
| single `src/main.rs` | a small binary |
| `src/lib.rs` + `src/main.rs` | logic in the lib (testable), thin binary on top — **preferred** for anything non-trivial |
| workspace (`[workspace] members = [...]`) | multiple related crates sharing a lockfile and `target/` |

Put real logic in a library crate and keep `main.rs` a thin shell — it makes the code testable
and reusable (this is also the spirit of `rust-architecture`). Module tree and `mod`/visibility
mechanics → `rust-idioms` (visibility) and `cargo.md` (workspaces).

## Supply-chain hygiene

```bash
cargo machete        # find unused dependencies
cargo tree -d        # find duplicate/conflicting versions
```

Trim what you don't use and de-duplicate the graph to keep the dependency liability in check.
Vulnerability/advisory scanning and license/supply-chain policy (`cargo-audit`/`cargo-deny`) →
`rust-security` (ties into `rust-review`'s and `rust-security`'s gates).

## Boundaries

- Publishing a library — semver discipline, public-API hygiene, doc conventions, interop →
  [libraries.md](libraries.md) (drawing on the Rust API Guidelines and Microsoft's Pragmatic
  Rust Guidelines).
- Dependency vulnerabilities, license/supply-chain policy, and unsafe-surface scanning
  (cargo-audit/deny/geiger) → `rust-security`.
- *Build* profiles for speed/size (LTO, codegen-units) → `rust-performance`.
- Build scripts (`build.rs`), `no_std`, and cross-compilation → [build-and-targets.md](build-and-targets.md).
- Naming and visibility idioms → `rust-idioms`.
