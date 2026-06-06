# Publishing a library

A library's API is a contract with strangers. The bar is higher than for an application:
breaking changes cost *everyone* downstream. Draws on the
[Rust API Guidelines](https://rust-lang.github.io/api-guidelines/) and Microsoft's
[Pragmatic Rust Guidelines](https://microsoft.github.io/rust-guidelines/) — read the latter's
*Libraries* chapter before a 1.0.

## Semver discipline

Once published, the version number is a promise. Breaking vs non-breaking:

| Breaking (major bump) | Non-breaking (minor/patch) |
|---|---|
| removing/renaming a `pub` item | adding a new `pub` item |
| adding a field to a struct with public fields | adding a field to a struct with private fields |
| adding a required trait method (no default) | adding a defaulted trait method |
| adding a variant to a non-`#[non_exhaustive]` enum | adding a variant to a `#[non_exhaustive]` enum |
| tightening a bound / changing a signature | loosening a bound |

Two tools that protect you:

- `#[non_exhaustive]` on public enums/structs reserves the right to add variants/fields without a
  major bump (consumers must use a wildcard arm / `..`).
- `cargo semver-checks` detects accidental breaking changes against the published version in CI.

## Public API hygiene

- Expose the **minimum** — `pub(crate)` everything that isn't part of the contract; a smaller
  surface is less to keep stable.
- Implement the standard traits where they apply: `Debug` (almost always), `Clone`, `Default`,
  `PartialEq`, plus `From`/`TryFrom` for conversions (→ `rust-idioms`). Their absence is a papercut
  for consumers.
- Typed errors with `thiserror`, not `anyhow`, in a library (→ `rust-errors`).
- Don't leak your dependencies' types in your public API unless you mean to commit to their
  semver too (re-export deliberately).
- Gate optional integrations behind additive features (→ [cargo.md](cargo.md)).

## Documentation conventions

Docs are part of the API. `cargo doc --open` is how consumers learn your crate.

```rust
#![warn(missing_docs)]   // or deny — force every public item to be documented

/// Parses a configuration from TOML.
///
/// # Examples
/// ```
/// # use mycrate::parse;
/// let cfg = parse("port = 8080").unwrap();
/// assert_eq!(cfg.port, 8080);
/// ```
///
/// # Errors
/// Returns [`ParseError`] if the input isn't valid TOML.
///
/// # Panics
/// Panics if ... (document any panic path, or state it never panics).
pub fn parse(input: &str) -> Result<Config, ParseError> { /* ... */ }
```

- Crate-level docs in `//!` at the top of `lib.rs`: what it's for, a quickstart example.
- Document every `pub` item; the conventional sections are `# Examples`, `# Errors`, `# Panics`,
  `# Safety` (for `unsafe fn` — → `rust-unsafe`).
- Examples in docs are compiled and run as tests (→ `rust-testing` doc tests) — they can't rot.
- Link items with intra-doc links: ``[`ParseError`]`` resolves to the type's page.

## Interop & resilience (library UX)

- Accept generic/borrowed inputs (`impl AsRef<Path>`, `&str`) and return owned, concrete types —
  flexible to call, predictable to use.
- Make types `Send + Sync` where feasible so they work in async/multithreaded consumers.
- Prefer `#[non_exhaustive]` on error enums and config structs from day one — it buys you room.
- Don't panic in library code for recoverable conditions; return `Result` (→ `rust-errors`).

## Pre-publish checklist

```bash
cargo doc --no-deps        # docs build clean, no broken intra-doc links
cargo test --doc           # examples compile and pass
cargo semver-checks        # no accidental breaking change
cargo publish --dry-run    # metadata (license, description, repository) is complete
```

Fill in `license`, `description`, `repository`, `keywords`, and `categories` in `[package]` —
crates.io requires them and they're how people find the crate.
