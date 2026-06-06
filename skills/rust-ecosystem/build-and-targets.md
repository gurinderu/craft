# Build scripts, no_std, and cross-compilation

The build-time and target-portability layer of a Rust project.

## `build.rs` — build scripts

A `build.rs` at the crate root compiles and runs **before** the crate, for code generation,
linking native libs, or capturing build-time info. Use it sparingly — it runs on every consumer's
machine and slows builds.

```rust
// build.rs
fn main() {
    // 1. Tell cargo when to re-run (default: any file change — too broad)
    println!("cargo::rerun-if-changed=proto/api.proto");
    println!("cargo::rerun-if-changed=build.rs");

    // 2. Codegen into OUT_DIR (never write into src/)
    let out = std::env::var("OUT_DIR").unwrap();
    generate_into(&out);

    // 3. Native linking
    println!("cargo::rustc-link-lib=foo");          // -lfoo
    println!("cargo::rustc-link-search=/opt/foo/lib");

    // 4. Expose a value to the crate as an env var / cfg
    println!("cargo::rustc-env=BUILD_SHA={}", sha());
    println!("cargo::rustc-check-cfg=cfg(has_feature_x)");   // declare the cfg (required since 1.80)
    println!("cargo::rustc-cfg=has_feature_x");
}
```

In the crate, pull generated code with `include!(concat!(env!("OUT_DIR"), "/generated.rs"))`.
Rules: **write only to `OUT_DIR`** (src/ is read-only at build time); always emit
`rerun-if-changed`/`rerun-if-env-changed` or you get needless rebuilds; keep heavy logic in a
`[build-dependencies]` crate, not inline. Since Rust 1.80 any custom `cfg` you emit via
`cargo::rustc-cfg=` must also be declared with `cargo::rustc-check-cfg=cfg(...)` (emit it
unconditionally), or you get an "unexpected cfg" warning. `tonic-build`/`prost-build`
(→ `rust-cloud-native`) are build scripts; so is `cc` for compiling C.

## `no_std` — no standard library

For embedded, kernels, and WASM-minimal builds: drop `std`, keep `core` (and opt into `alloc`
if you have an allocator).

```rust
#![no_std]
extern crate alloc;                 // if you have a global allocator
use alloc::{vec::Vec, string::String};   // collections move from std:: to alloc::
use core::fmt;                       // most of std's non-alloc API lives in core::
```

- `core` = always available (no allocation, no OS): `Option`, `Result`, iterators, `fmt`, slices.
- `alloc` = heap types (`Vec`, `String`, `Box`, `Rc`) — needs a `#[global_allocator]`.
- `std` = `alloc` + OS (files, threads, net, time) — unavailable in `no_std`.
- A binary also needs `#![no_main]` + a `#[panic_handler]` (no default unwinder).

Write libraries `no_std`-friendly with a feature toggle so they work in both worlds:

```toml
[features]
default = ["std"]
std = []            # gate std-only APIs behind this
```

```rust
#![cfg_attr(not(feature = "std"), no_std)]
```

This is the foundation for embedded/bare-metal work (a domain beyond this plugin's current
scope); the ownership rules are unchanged (→ `rust-ownership`).

## Cross-compilation

Rust cross-compiles via **target triples** (`<arch>-<vendor>-<os>-<abi>`):

```bash
rustup target add aarch64-unknown-linux-musl     # add the std for a target
cargo build --release --target aarch64-unknown-linux-musl
```

- Pure-Rust crates cross-compile cleanly; ones with C deps need a cross **linker/toolchain**.
- **`cross`** (`cargo install cross`; `cross build --target ...`) runs the build in a Docker image
  with the toolchain preinstalled — the easiest path for C-linking targets.
- **musl** targets (`x86_64-unknown-linux-musl`) produce a **static** binary — ideal for
  `scratch`/distroless containers (→ `rust-cloud-native`).

### Conditional compilation

Compile different code per target/feature with `cfg`:

```rust
#[cfg(target_os = "linux")]      fn platform() { /* ... */ }
#[cfg(target_arch = "wasm32")]   fn platform() { /* ... */ }
#[cfg(feature = "std")]          use std::time::Instant;
```

`#[cfg(test)]` (→ `rust-testing`) is the same mechanism. Keep `cfg` blocks small and provide an
implementation for every supported target, or the build breaks where you forgot one.
