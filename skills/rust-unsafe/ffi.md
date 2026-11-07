# FFI — crossing the C boundary

FFI is the most common reason to write unsafe. The compiler can't see across the boundary, so
the contract (signatures, layout, ownership, lifetimes) is entirely your responsibility.

## Calling C

```rust
// link against a C library exporting: int add(int, int);
unsafe extern "C" {
    fn add(a: i32, b: i32) -> i32;
}

let n = unsafe { add(2, 3) };   // SAFETY: signature matches the C declaration exactly
```

The signature must match the C side *exactly* — a wrong type or ABI is UB. Generate bindings
from the C headers with **`bindgen`** instead of hand-writing them when the surface is non-trivial.

## Layout: `#[repr(C)]`

Rust's default layout is unspecified and reorders fields. Any type crossing the boundary must
have a stable, C-compatible layout:

```rust
use std::ffi::c_void;

#[repr(C)]
struct Point { x: f64, y: f64 }      // C-compatible field order & padding

#[repr(transparent)]
struct Handle(*mut c_void);          // same ABI as the single field — for newtype wrappers
```

Use `#[repr(C)]` for structs/unions shared with C, and `#[repr(C)]` (or a primitive repr like
`#[repr(i32)]` to pin the width) for enums sent across, and assign explicit discriminant values
to match the C side.

## Exposing Rust to C

```rust
#[unsafe(no_mangle)]
pub extern "C" fn rust_add(a: i32, b: i32) -> i32 { a + b }
```

Generate the matching C header with **`cbindgen`**.

## Strings

C strings are null-terminated `char*`; Rust strings are length-prefixed and not null-terminated.
Convert explicitly and mind ownership:

```rust
use std::ffi::{CStr, CString};

// Rust -> C: keep the CString alive while C uses the pointer
let c = CString::new("hello").unwrap();
unsafe { c_takes_str(c.as_ptr()) };          // c must outlive this call

// C -> Rust: borrow a C pointer (must be valid, null-terminated)
let s = unsafe { CStr::from_ptr(ptr) }.to_str().unwrap();
```

## Ownership across the boundary

Raw pointers carry no ownership or lifetime — you must define and document who allocates and who
frees. The pattern for handing a Rust value to C and back:

```rust
// Rust allocates, C holds an opaque pointer, Rust frees later.
let boxed = Box::new(state);
let raw = Box::into_raw(boxed);              // leak to C; C now owns it
// ... later, when C returns it:
let state = unsafe { Box::from_raw(raw) };   // SAFETY: raw came from Box::into_raw, freed once
```

Free with the *same allocator* that allocated: memory from C is freed by C, memory from Rust by
Rust. Double-free and use-after-free across the boundary are classic FFI UB.

## Null and validity

Every incoming pointer is suspect — check for null and uphold the documented validity before
dereferencing:

```rust
if ptr.is_null() { return ERR_NULL; }
let r = unsafe { &*ptr };    // SAFETY: non-null checked; caller guarantees it's valid & aligned
```

## Send/Sync and panics

- Raw pointers are **not** `Send`/`Sync`. A wrapper that crosses threads needs an
  `unsafe impl Send`/`Sync` with a `// SAFETY:` justifying real thread-safety — don't assert it
  blindly.
- **A panic must not unwind across an `extern "C"` boundary** — it's UB. Wrap fallible Rust
  exposed to C in `std::panic::catch_unwind` and convert to an error code, or use the
  `extern "C-unwind"` ABI only when the other side is built to handle unwinding.
