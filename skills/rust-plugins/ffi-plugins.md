# cdylib + C-ABI plugins

Near-native speed, full crate ecosystem — at the cost of **no isolation** and hand-managed
unsafe. Use only for **trusted** code. The general unsafe/FFI rules live in `rust-unsafe`; this
is the plugin-specific layer.

## Why C-ABI (not Rust's)

Rust has **no stable ABI** — a plugin built with a different compiler version (or even flags)
has an incompatible memory layout, so loading it is UB. The C ABI *is* stable across compilers
and OSes, so you constrain the plugin interface to it.

## The rules

1. **`#[repr(C)]` on every type that crosses the boundary.** `repr(Rust)` reorders fields and is
   unspecified; `repr(C)` is predictable (and slightly larger — a real tradeoff).
2. **FFI-safe types only**: primitives, `*const T`/`*mut T`, `Option<NonNull<T>>`, `repr(C)`
   enums/structs of those. **No** `String`, `Vec`, `HashMap`, trait objects across the boundary —
   pass `*const u8 + len`, C strings, or your own `repr(C)` structs.
3. **No panics across the boundary.** Unwinding through `extern "C"` is UB. Wrap each entrypoint
   in `catch_unwind` and return an error enum, or build the plugin with `panic = "abort"`.
4. **Allocator discipline.** Memory allocated on one side is freed on the same side. Prefer
   host-owned buffers; never build a `Vec`/`CString` from a foreign pointer and drop it (double
   free). Document ownership: `*const` = read-only/host-owned, `*mut` = transferable.
5. **Version the interface.** Export an ABI version from the plugin and check it on load — a
   mismatch should be rejected cleanly, not crash.

## Plugin side (cdylib)

```toml
[lib]
crate-type = ["cdylib"]
[profile.release]
panic = "abort"          # or use catch_unwind per entrypoint
```

```rust
#[repr(C)]
pub struct PluginMetadata { abi_version: u32, name: *const std::ffi::c_char }

#[unsafe(no_mangle)]
pub extern "C" fn plugin_metadata() -> PluginMetadata { /* ... */ }

#[unsafe(no_mangle)]
pub extern "C" fn plugin_call(input: *const u8, len: usize, out: *mut Buffer) -> i32 {
    // SAFETY: host guarantees input/len valid for this call; out is host-owned.
    let r = std::panic::catch_unwind(|| {
        let bytes = unsafe { std::slice::from_raw_parts(input, len) };
        run(bytes)                       // safe Rust does the work
    });
    match r {
        Ok(Ok(bytes)) => { /* copy into host-owned `out` */ 0 }
        Ok(Err(_))    => 1,              // domain error
        Err(_)        => 2,              // a panic was caught — never let it unwind
    }
}
```

## Host side (`dlopen2`)

```toml
[dependencies]
dlopen2 = "0.8"
```

```rust
use dlopen2::wrapper::{Container, WrapperApi};

#[derive(WrapperApi)]
struct PluginApi {
    plugin_metadata: unsafe extern "C" fn() -> PluginMetadata,
    plugin_call: unsafe extern "C" fn(*const u8, usize, *mut Buffer) -> i32,
}

let api: Container<PluginApi> = unsafe { Container::load("./plugin.so")? };
let meta = unsafe { api.plugin_metadata() };
assert_eq!(meta.abi_version, EXPECTED_ABI);   // reject mismatches
```

## The safer path: `abi_stable` (or `stabby`)

Hand-rolling `#[repr(C)]` for a rich interface is error-prone. [`abi_stable`](https://crates.io/crates/abi_stable)
provides stable-ABI std-like types (`RString`, `RVec`, `RBox`) and `#[sabi_trait]` trait objects
that cross the boundary safely, plus runtime layout checking that *detects* an ABI mismatch
instead of letting it corrupt memory.

```toml
[dependencies]
abi_stable = "0.11"
```

For Rust↔Rust plugins this is usually the right choice over raw FFI — you get ergonomic types and
a checked ABI. `stabby` is a newer alternative with similar goals (note its unusual,
ABI-tracking version numbers). Still **no sandboxing** — these solve *ABI safety*, not *trust*.
For untrusted code, use WASM ([wasm-plugins.md](wasm-plugins.md)).
