# Crate extraction: when and how

When does code belong in its own crate, and how do you pull it out — or, when an over-split
crate earns its keep, when do you merge it back. The shape of a workspace is a design decision
with real costs on both sides; make it on a driver, not a hunch.

## When to extract (each is a driver — you want at least one)

| Driver | Signal | Owner of the deeper "how" |
|---|---|---|
| Reuse | the code is (or will be) consumed by more than one crate/binary | `rust-ecosystem` (workspaces) |
| Compile parallelism | a module is a recompile hotspot or serializes the build | `rust-performance` → [compile-times.md](../rust-performance/compile-times.md) |
| Dependency inversion | a port/trait + adapters belong behind a boundary so the core doesn't depend on the framework | `rust-architecture` (ports) |
| Trust boundary | a swappable/sandboxed plugin or FFI surface | `rust-plugins` |
| Independent release | the code must version / publish on its own cadence | `rust-ecosystem` → [libraries.md](libraries.md) |
| Test isolation | heavy integration-test deps that shouldn't leak into the main build | `rust-testing` |
| God-crate split | one crate doing too much, with internally separable concerns | `rust-architecture` |

## How to extract

1. Add a workspace member: `[workspace] members = [..., "crates/foo"]`.
2. Move the module's files into the new crate; give it a `Cargo.toml` (name, version, edition).
3. Expose the **minimum** `pub` surface — the new crate boundary is now a public API (visibility
   → `rust-idioms`).
4. Re-export from the original crate (`pub use foo::…`) if downstream code shouldn't have to change
   its paths yet.
5. From here the new public surface has **semver** obligations like any library (→ [libraries.md](libraries.md)).

## When NOT to extract (the cost side)

Every crate boundary costs link time, `Cargo.toml` boilerplate, and cross-crate coordination, and
it ossifies an API across the boundary. So:

- **Don't** extract a single-consumer module that has no reuse / compile / boundary driver — it
  just adds ceremony.
- **Don't** extract prematurely — pulling out an API you're still reshaping freezes it before it's
  ready.
- **Reverse signal — merge back:** a crate with a single consumer and no boundary reason is
  over-split; fold it into its consumer.
