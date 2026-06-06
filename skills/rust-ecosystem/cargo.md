# Cargo: dependencies, features, workspaces

## Dependency versions and semver

```toml
[dependencies]
serde = "1.0"          # caret by default: >=1.0.0, <2.0.0 — any semver-compatible 1.x
tokio = "=1.40.0"      # exact pin (rarely needed; blocks patches)
rand  = "0.8"          # pre-1.0: 0.8 means >=0.8.0, <0.9.0 (minor is breaking here)
```

`"1.0"` is a caret range — Cargo takes the newest compatible version. For **pre-1.0** crates,
the *minor* is the breaking position (`0.8` ≠ `0.9`), so pin to the minor you tested. `Cargo.lock`
records the exact resolved versions.

## Features — additive, always

Features turn on optional functionality/dependencies. The cardinal rule: **features must be
additive** — enabling one must never remove or change behavior, because Cargo *unifies* the
union of all features requested anywhere in the dependency graph.

```toml
[features]
default = ["std"]
std = []
serde = ["dep:serde"]          # `dep:` ties a feature to an optional dependency
full = ["std", "serde"]

[dependencies]
serde = { version = "1.0", optional = true }   # pulled in only when the `serde` feature is on
```

Consequences of unification you must design around:

- **No mutually-exclusive features.** If crate A enables `foo` and crate B enables `bar`, your
  crate gets both. Don't make features that contradict each other.
- **Keep `default` minimal.** Consumers do `default-features = false` to slim builds; don't bury
  must-haves only in non-default features.
- Test the matrix with `cargo hack --feature-powerset check` so a feature combo doesn't fail to
  compile.

```toml
# consumer turning off defaults and picking features
serde = { version = "1.0", default-features = false, features = ["derive"] }
```

## Dependency kinds

```toml
[dependencies]          # needed at runtime
[dev-dependencies]      # tests, benches, examples only — never in the shipped artifact
[build-dependencies]    # used by build.rs
[target.'cfg(unix)'.dependencies]   # platform-specific
```

Test-only crates (`rstest`, `proptest`, `criterion`, `mockall`) belong in `[dev-dependencies]`
(see `rust-testing`).

## Workspaces

Group related crates so they share one `Cargo.lock`, one `target/`, and common dependency
versions:

```toml
# top-level Cargo.toml
[workspace]
resolver = "3"
members = ["crates/core", "crates/api", "crates/cli"]

[workspace.dependencies]            # declare once, inherit everywhere
serde = "1.0"
tokio = { version = "1", features = ["rt-multi-thread", "macros"] }
```

```toml
# crates/api/Cargo.toml
[dependencies]
serde.workspace = true              # inherit the workspace version + features
core = { path = "../core" }         # intra-workspace path dependency
```

Workspaces keep versions consistent and builds fast (shared compilation). Use `resolver = "3"`
(implied by edition 2024, MSRV-aware feature resolution) — set it explicitly at the workspace
root, since the resolver is workspace-global and is *not* inherited from member crates' editions.

## Useful cargo subcommands

| Command | Does |
|---|---|
| `cargo add` / `cargo remove` | edit dependencies (built-in) |
| `cargo tree -d` | find duplicate/conflicting versions |
| `cargo hack` | feature-powerset / MSRV matrix checks |
| `cargo deny check` | licenses, advisories, banned/duplicate deps |
| `cargo machete` | unused dependencies |
| `cargo +nightly udeps` | unused deps (nightly, more thorough) |
| `cargo outdated` | dependencies behind their latest |
