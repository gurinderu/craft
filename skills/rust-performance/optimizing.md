# Optimizations

Apply these **after** profiling points at a hot spot — and re-benchmark each one. Distilled from
the [Rust Performance Book](https://nnethercote.github.io/perf-book/).

## Build configuration (free, no code change)

Often the best effort:reward ratio. In `Cargo.toml`:

```toml
[profile.release]
lto = "fat"          # cross-crate inlining + dead-code elim: 10-20%+, much slower compile
codegen-units = 1    # whole-crate optimization (default 16 parallelizes but misses opts)
panic = "abort"      # abort instead of unwind: removes landing pads — smaller/slightly faster; catch_unwind can no longer recover.
```

```toml
# .cargo/config.toml — emit instructions for the build machine's CPU (AVX, etc.)
[build]
rustflags = ["-C", "target-cpu=native"]   # ⚠ binary won't run on older CPUs
```

For size instead of speed: `opt-level = "z"` (or `"s"`) and `strip = "symbols"`.

## Heap allocations

Allocation is often the hidden cost. Reduce the count:

- **Pre-size**: `Vec::with_capacity(n)` / `reserve(n)` and `HashMap::with_capacity` — one
  allocation instead of several reallocations as it grows. Same for strings.
- **Reuse buffers**: pass `&mut Vec<T>` instead of returning a fresh one; `.clear()` and refill
  in a loop; `clone_from(&src)` reuses the destination's allocation.
- **Drop capacity overhead**: `vec.into_boxed_slice()` turns a `Vec` into `Box<[T]>` (3 words →
  2) when you won't resize it again.
- **Inline small collections**: `smallvec` (`SmallVec<[T; N]>`) keeps up to N elements on the
  stack, heap only on overflow; `arrayvec::ArrayVec` when the max is fixed (no heap at all).
- **Avoid throwaway allocations** in hot code: skip needless `.clone()`, prefer `&str` over
  `String`, `Cow<str>` for "usually borrowed", and `write!` into a reused buffer over `format!`.
- **Files**: `BufRead::read_line` into a reused `String` rather than `.lines()` (which allocates
  a `String` per line).

## Hashing

The default `HashMap` uses SipHash 1-3 — collision-resistant but slow, especially for small
keys like integers. If profiling shows hashing is hot **and** HashDoS isn't a concern (not
attacker-controlled keys):

```toml
[dependencies]
rustc-hash = "2"     # FxHashMap / FxHashSet — very fast, low quality, great for int keys
# or
ahash = "0.8"        # uses AES instructions where available
```

```rust
use rustc_hash::FxHashMap;
let mut m: FxHashMap<u32, u32> = FxHashMap::default();
```

Don't change the default blindly — for untrusted keys, SipHash's DoS resistance is the point.

## Type sizes

Big types cost `memcpy`s, stack space, and cache misses.

- **Measure**: `RUSTFLAGS=-Zprint-type-sizes cargo +nightly build --release` (or the
  `top-type-sizes` crate) shows sizes, padding, and discriminants.
- **Box large/rare enum variants**: an enum is as big as its biggest variant. If one variant is
  huge and uncommon, box it — `Z(Box<LargeThing>)` — so the enum shrinks to a pointer for the
  common cases.
- **Smaller integers** for indices/counts: `u32` instead of `usize` where the range allows,
  coercing at use sites.
- **`Box<[T]>` / `ThinVec`**: boxed slice drops `Vec`'s capacity word; `thin_vec::ThinVec` is one
  word wide — len/cap live in a heap header alongside the elements — ideal for frequently-empty
  vectors in hot structs.
- Field ordering is automatic — the compiler reorders for you unless `#[repr(C)]`. Don't hand-pack.

## Iterators and bounds checks

Iterator chains are zero-cost — they compile to the same (often better) code as a manual loop,
and they let the compiler **elide bounds checks** that indexing can't always prove away. Prefer
`for x in &v` / `.iter().map().filter()` over `for i in 0..v.len() { v[i] }`.

When a profiler proves a bounds check dominates a hot loop and you can't restructure to remove
it, `slice::get_unchecked` exists — but it's `unsafe` and a last resort (→ `rust-unsafe`); a
correct iterator almost always wins without it.

## Inlining

Across crate boundaries the compiler can't inline by default. For small, hot, cross-crate
functions, `#[inline]` (or `#[inline(always)]` sparingly) can help — but don't sprinkle it
everywhere (it bloats compile time and binary), and enabling LTO removes much of the need.

---

**Every change gets re-benchmarked.** A plausible optimization that doesn't move the number is
just added complexity — revert it.
