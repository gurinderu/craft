---
name: rust-plugins
description: Plugin and extensibility systems in Rust — choosing between compile-time trait objects, embedded scripting, out-of-process RPC, WebAssembly, and dynamic C-ABI libraries, driven first by the trust boundary. Use when designing extensibility, loading user/third-party code at runtime, supporting user-defined functions, or picking a plugin mechanism. Triggers: plugin, plugin system, extensibility, dynamic loading, cdylib, dlopen, FFI plugin, abi_stable, stabby, wasm plugin, wasmtime, extism, scripting, rhai, user-defined function, UDF, hot reload.
---

# Rust Plugin Systems

How do you let code be added without recompiling the host? Five approaches with very different
tradeoffs. **Choose by the trust boundary first**, performance second — that's the axis people
get wrong. Mechanics for the two hard paths are in the sub-files.

## When to Use

- Designing an extensibility / plugin mechanism
- Running user- or third-party-supplied code at runtime
- Supporting user-defined functions (UDFs)
- Picking between WASM, dynamic libs, scripting, RPC

## Decision: trust first

The first question isn't "how fast" — it's **do you trust the plugin code?**

```
Is the plugin code trusted (first-party, vendored, audited)?
├─ NO  → you need isolation: WASM (in-process sandbox) or a separate process (RPC).
│        Never load untrusted native code into your address space.
└─ YES → optimize for fit:
         ├─ compiled together?         → trait objects / enum dispatch (no "plugin system" at all)
         ├─ need native speed + crates → cdylib + C-ABI
         ├─ end-user-authored logic    → embedded scripting (rhai/lua)
         └─ multi-language, portable    → WASM (even when trusted, for portability)
```

## The five approaches

| Approach | Trust needed | Perf | Isolation | Languages | Complexity |
|---|---|---|---|---|---|
| **Trait objects / enum dispatch** (compiled in) | n/a (same binary) | native | none | Rust | lowest — *not really a plugin system* |
| **Embedded scripting** (rhai, mlua) | medium | slow | partial | the script lang | low |
| **Out-of-process + RPC** | low | slow (IPC+serde) | **strong** (crash/resource) | any | high (deploy) |
| **WebAssembly** (wasmtime, extism) | **low** | 1.5–3× native | **strong** (sandbox) | many → wasm | medium |
| **cdylib + C-ABI** (dlopen) | **high** | ~native | **none** (shared address space) | any (C ABI) | medium, unsafe-heavy |

Key truth: **cdylib gives zero isolation** — a buggy or malicious plugin can segfault or corrupt
the host. It's the right pick *only* for trusted, performance-critical, Rust-ecosystem code
(e.g. first-party UDFs). For untrusted plugins, WASM or a separate process is the default even
at a perf cost.

## If you compile the plugins in: don't build a plugin system

If "plugins" are a known, first-party set shipped with the host, you don't need dynamic loading
at all — a `trait` + `Vec<Box<dyn Plugin>>` (or enum dispatch) is simpler, faster, and safe
(→ `rust-traits` dispatch). Reach for the dynamic mechanisms below only when code must load
*without recompiling the host*.

## The two hard paths

- **cdylib + C-ABI** — near-native, full crate access, trusted code only. The discipline
  (`#[repr(C)]`, FFI-safe types, panic/allocator/ABI rules) and the safer `abi_stable`/`stabby`
  alternatives are in [ffi-plugins.md](ffi-plugins.md).
- **WebAssembly** — sandboxed, portable, untrusted-safe, with a perf and capability cost.
  `wasmtime` (low-level) and `extism` (batteries-included) in [wasm-plugins.md](wasm-plugins.md).

## Boundaries

- The unsafe FFI mechanics under a cdylib plugin → `rust-unsafe` (this skill is the
  architecture decision; ffi-plugins.md is the plugin-specific layer on top).
- A plugin interface is a **dynamic port** — the same dependency-inversion idea as
  `rust-architecture`, resolved at runtime instead of compile time.
- Compile-time polymorphism (the "trait objects" row) → `rust-traits`.
