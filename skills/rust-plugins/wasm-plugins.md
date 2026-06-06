# WebAssembly plugins

The choice when plugins are **untrusted** or must be **portable/multi-language**. You trade
1.5–3× native speed for a real sandbox: the plugin can't touch memory, files, or syscalls you
don't explicitly grant.

## Why WASM

- **Sandboxed** — linear memory is isolated; the guest can't read/write host memory or call the
  OS unless you wire it up. Safe for untrusted code.
- **Portable** — one `.wasm` runs on any OS/arch.
- **Multi-language** — anything that compiles to wasm (Rust, C, Go, AssemblyScript, …).
- **Resource-limited** — cap CPU (fuel/epochs) and memory per instance.

Costs: slower than native; **no threads/syscalls** without WASI plumbing; can't link C libs; and
most dynamic languages need their whole interpreter compiled to wasm (Pyodide-style), which is
heavy. Best for self-contained compute (UDFs, transforms, rules), not for plugins that need the
full OS.

## High-level: `extism`

[`extism`](https://extism.org) is a plugin framework over wasmtime — host functions, memory
handling, and the calling convention are done for you. Start here unless you need raw control.

```toml
[dependencies]
extism = "1"
```

```rust
use extism::{Manifest, Plugin, Wasm};

let manifest = Manifest::new([Wasm::file("plugin.wasm")]);
let mut plugin = Plugin::new(&manifest, [], true)?;   // true = with WASI
let out: &[u8] = plugin.call("transform", input)?;     // call an exported function
```

Plugins are authored against the Extism PDK in many languages; the host stays the same.

## Low-level: `wasmtime`

[`wasmtime`](https://crates.io/crates/wasmtime) when you need full control over imports, limits,
and the component model.

```toml
[dependencies]
wasmtime = "45"
```

```rust
use wasmtime::*;

let mut config = Config::new();
config.consume_fuel(true);                  // must enable fuel on the config first
let engine = Engine::new(&config)?;
let module = Module::from_file(&engine, "plugin.wasm")?;
let mut store = Store::new(&engine, ());
store.set_fuel(1_000_000)?;                 // bound execution (CPU)
let mut linker = Linker::new(&engine);
// linker.func_wrap("host", "log", |s: i32| { ... })?;  // grant capabilities explicitly
let instance = linker.instantiate(&mut store, &module)?;
let run = instance.get_typed_func::<i32, i32>(&mut store, "run")?;
let result = run.call(&mut store, 42)?;
```

The host grants capabilities one function at a time — the default is **deny**, which is the whole
point. Bound runaway plugins with `set_fuel` (or epoch interruption) and `StoreLimits` for memory.

## Interface: the Component Model / WIT

For typed, language-agnostic interfaces beyond raw `i32`/memory, use the **Component Model** with
**WIT** (`.wit` interface files) — `wasmtime`'s `bindgen!` and `cargo component` generate typed
host/guest bindings, so you pass records/strings/lists instead of hand-marshaling linear memory.
This is where the wasm plugin ecosystem is heading.

## Choosing within WASM

- Just run untrusted compute, minimal fuss → **extism**.
- Need custom host imports, fine-grained limits, or typed component interfaces → **wasmtime**
  (+ WIT/component model).
