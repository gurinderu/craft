# Raw pointers, invariants, and safe abstractions

## Raw pointers

`*const T` and `*mut T` carry no guarantees — they may be null, dangling, unaligned, or alias
freely. **Creating** one is safe; **dereferencing** is the unsafe act.

```rust
let x = 42;
let p: *const i32 = &x;       // safe to make
let v = unsafe { *p };        // SAFETY: p came from a live &x, so it's valid & aligned
```

Get them from references (`&x as *const _`), from `Box::into_raw`, or `ptr::null()`. Don't
fabricate addresses or keep a pointer past its referent's life.

## The safe-abstraction pattern (the core idiom)

Confine unsafe to a small core and expose a checked safe API. The checks turn caller mistakes
into safe errors instead of UB.

```rust
pub struct RingBuffer<T> { buf: Box<[MaybeUninit<T>]>, head: usize, len: usize }

impl<T> RingBuffer<T> {
    pub fn get(&self, i: usize) -> Option<&T> {
        if i >= self.len { return None; }                 // safe check at the boundary
        let idx = (self.head + i) % self.buf.len();
        // SAFETY: i < len, so slot `idx` was initialized by a prior push.
        Some(unsafe { self.buf[idx].assume_init_ref() })
    }
}
```

Callers of `get` can't trigger UB — the unsafe is sealed behind the bounds check. This is how
the standard library's containers are built.

## `get_unchecked` — the perf escape hatch

`slice::get_unchecked` skips the bounds check. It's `unsafe` and a **last resort** — only after
`rust-performance` profiling proves the check dominates a hot loop:

```rust
let mut sum = 0;
// SAFETY: loop runs 0..v.len(), so i is always in bounds.
// `*` derefs by value, so this assumes the element type is `Copy`.
for i in 0..v.len() { sum += unsafe { *v.get_unchecked(i) }; }
```

A correct iterator usually matches its speed without any unsafe — try that first.

## Uninitialized memory: `MaybeUninit`

Reading uninitialized memory is instant UB. Never `mem::uninitialized` (removed for this
reason); use `MaybeUninit` and only `assume_init` once you've actually written the value.

```rust
let mut slot = MaybeUninit::<Config>::uninit();
slot.write(Config::load());
let cfg = unsafe { slot.assume_init() };  // SAFETY: written on the line above
```

## `transmute` — almost always avoidable

`mem::transmute` reinterprets bits between same-size types and is the easiest way to cause UB
(invalid values, layout assumptions, lifetime laundering). Prefer the targeted alternative:

| Want | Use instead of transmute |
|---|---|
| integer ↔ bytes | `to_ne_bytes` / `from_ne_bytes` |
| pointer cast | `ptr as *const U`, `.cast()` |
| `&T` ↔ `&U` plain-old-data | `bytemuck` crate (checked) |
| enum from integer | a `match` / `TryFrom` |

If you truly must `transmute`, document that both types have identical size **and** the bit
pattern is valid for the target.

## `UnsafeCell` — the root of interior mutability

`UnsafeCell<T>` is the *only* sound way to get `&mut T` from a `&T`; it's the primitive under
`Cell`, `RefCell`, `Mutex`, and atomics. You rarely use it directly, but knowing it exists
explains *why* those safe types are sound — they wrap `UnsafeCell` and add the discipline
(runtime borrow flags, locks) that upholds the aliasing rule.

## `static mut` — avoid

A mutable `static` is a global with no synchronization; almost any access risks a data race and
recent editions lint hard against it. Reach for an atomic, a `Mutex`, or `OnceLock` instead —
all safe (→ `rust-concurrency`).
