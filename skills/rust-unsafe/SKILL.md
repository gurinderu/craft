---
name: rust-unsafe
description: Unsafe Rust done soundly — what unsafe does and doesn't unlock, the SAFETY-comment discipline, undefined behavior to avoid, raw pointers, FFI, #[repr], and verifying with Miri. Use when writing or reviewing unsafe code, doing FFI, building a data structure the borrow checker can't express, or chasing UB. Triggers: unsafe, raw pointer, *const, *mut, FFI, extern "C", #[repr(C)], SAFETY, undefined behavior, UB, transmute, MaybeUninit, miri, get_unchecked, bindgen, union, no_mangle.
---

# Unsafe Rust

`unsafe` doesn't turn Rust off — it unlocks five extra abilities and **moves the proof of
soundness from the compiler to you**. The whole craft is: do the minimum unsafe, wrap it in a
safe API, and prove every invariant in writing. Mechanics in the sub-files.

## When to Use

- Writing or reviewing `unsafe` blocks / `unsafe fn` / `unsafe impl`
- FFI — calling C, or exposing Rust to C ([ffi.md](ffi.md))
- Building something the borrow checker can't express (intrusive lists, custom containers)
- A hot-path optimization that profiling proved needs it (→ `rust-performance` decides *whether*)

## What `unsafe` does and doesn't do

It does **not** disable the borrow checker, type checking, or lifetimes inside the block. It
unlocks exactly **five superpowers** — and nothing else:

1. Dereference a raw pointer (`*const T` / `*mut T`)
2. Call an `unsafe fn` / unsafe method
3. Access or modify a mutable `static`
4. Implement an `unsafe trait` (`Send`, `Sync`, …)
5. Access the fields of a `union`

Everything else still obeys the normal rules. The danger is only ever one of these five — when
reviewing, find which one and check its invariant.

## The SAFETY discipline (non-negotiable)

- Every `unsafe { … }` block carries a `// SAFETY:` comment stating **why** the invariants hold
  here.
- Every `unsafe fn` documents a `# Safety` section listing the preconditions the **caller** must
  uphold (these are the obligations the function can't check).
- Every `unsafe impl Send/Sync` explains why it's actually thread-safe.

```rust
/// # Safety
/// `ptr` must be non-null, aligned, and valid for `len` reads of `T`,
/// and the memory must not be mutated for the duration of `'a`.
unsafe fn view<'a, T>(ptr: *const T, len: usize) -> &'a [T] {
    // SAFETY: guaranteed by this fn's contract, which the caller upholds.
    unsafe { std::slice::from_raw_parts(ptr, len) }
}
```

clippy's `undocumented_unsafe_blocks` lint enforces the block comments — turn it on.

## Undefined behavior — the cardinal sins

UB is not "a crash" — it lets the optimizer assume the impossible and miscompile the **whole**
program, often far from the unsafe site. Never cause any of:

- a **data race** (unsynchronized concurrent access with a writer)
- dereferencing a **null, dangling, or misaligned** pointer
- violating **aliasing**: two `&mut` to the same place, or `&mut` aliasing a `&`
- producing an **invalid value**: a `bool` that isn't 0/1, an out-of-range enum discriminant, an
  uninitialized integer read, an invalid `char`
- breaking **pointer provenance** / using a pointer outside its allocation
- calling across FFI with the wrong signature/ABI, or letting a panic cross `extern "C"`

If you can't prove none of these happen, the code is unsound even if it "works today".

## The golden rule: encapsulate

Keep `unsafe` tiny and wrap it in a safe, checked API so callers can't misuse it. `Vec`,
`RefCell`, and `Mutex` are exactly this — a sound safe surface over an unsafe core (built on
`UnsafeCell`; see [raw-and-invariants.md](raw-and-invariants.md)). Unsafe that leaks its
obligations to ordinary callers is a bug.

## Verify with Miri

The compiler can't catch UB; **Miri** can (at runtime, under interpretation):

```bash
cargo +nightly miri test          # detects UB: OOB, use-after-free, alignment, data races, leaks
```

Run unsafe code under Miri in CI. It's the single highest-value tool for unsafe Rust. Pair it
with **fuzzing** to *reach* the UB: fuzz the unsafe/FFI surface, run the corpus under Miri so the
adversarial inputs are checked for undefined behavior (`cargo-fuzz` + `arbitrary`) → `rust-testing`.

## Boundaries

- The *safe* ownership model (when you **don't** need unsafe) → `rust-ownership`. Most "the
  borrow checker won't let me" cases have a safe answer there first.
- *Whether* a perf optimization justifies unsafe (`get_unchecked`, SIMD) → `rust-performance`;
  *how* to write it soundly → here ([raw-and-invariants.md](raw-and-invariants.md)).
- Reviewing unsafe in a diff (require `// SAFETY:`) → `rust-review`.
