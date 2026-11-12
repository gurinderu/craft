# Type-driven design

Use the type system to make illegal states unrepresentable — push errors from runtime to
compile time.

## Newtype

Wrap a type in a single-field struct to give it meaning, enforce invariants, or implement a
foreign trait (the orphan-rule workaround).

```rust
// Meaning + no mixing up arguments of the same primitive
struct UserId(u64);
struct OrderId(u64);
fn fulfill(order: OrderId, user: UserId) { /* can't swap them — different types */ }

// Enforced invariant: a value that can only exist if valid
pub struct Email(String);
impl Email {
    pub fn parse(s: String) -> Result<Self, EmailError> {
        if s.contains('@') { Ok(Email(s)) } else { Err(EmailError) }
    }
}
// Once you hold an `Email`, it's valid by construction — no re-checking downstream.

// Wrap the foreign type in a local newtype so you CAN impl a foreign trait (orphan-rule workaround)
struct Wrapper(Vec<u8>);
impl std::fmt::Display for Wrapper { /* ... */ }
```

"Parse, don't validate": turn unstructured input into a type that *can't* be invalid, at the
boundary, once.

## Typestate — encode the state machine in types

Make invalid transitions un-compilable by carrying the state as a type parameter. A method
consumes one state and returns the next; calling a wrong-state method doesn't compile.

```rust
use std::marker::PhantomData;

struct Open;
struct Closed;

struct Door<State> { _state: PhantomData<State> }

impl Door<Closed> {
    fn new() -> Self { Door { _state: PhantomData } }
    fn open(self) -> Door<Open> { Door { _state: PhantomData } }
}
impl Door<Open> {
    fn close(self) -> Door<Closed> { Door { _state: PhantomData } }
}

let door = Door::<Closed>::new().open();
// door.open();  // ❌ won't compile: no `open` on Door<Open>
```

The classic real use is a builder that only exposes `build()` once required fields are set.

## `PhantomData`

A zero-sized marker that tells the compiler a type "uses" a parameter it doesn't store —
needed for typestate markers, for variance, and for FFI/ownership over a `T` you only hold by
raw pointer.

```rust
struct Id<T> { value: u64, _ty: PhantomData<T> }   // Id<User> vs Id<Order>, same runtime layout
```

It occupies no space; it exists only to make the type parameter real to the type checker.

## Sealed traits — allow impls only inside your crate

Let users *call* a trait but not *implement* it (so you can add methods later without breaking
them): bound it on a private trait they can't name.

```rust
mod sealed { pub trait Sealed {} }

pub trait Connector: sealed::Sealed {   // public API
    fn connect(&self);
}

pub struct Tcp;
impl sealed::Sealed for Tcp {}          // only your crate can do this
impl Connector for Tcp { fn connect(&self) {} }
```

## Make illegal states unrepresentable

Prefer types whose every value is valid over types you must remember to check.

```rust
// Bad — two bools allow the impossible (loading && done)
struct Task { loading: bool, done: bool, error: Option<String> }

// Good — the enum permits only the real states
enum Task {
    Idle,
    Loading,
    Done(Output),
    Failed(String),
}
```

Reach for `enum` over flag combinations, `NonZeroU32`/`NonZero` over "0 means none", and a
newtype over "a `String` that's been validated somewhere". The compiler then rejects the states
you'd otherwise have to test for.

## Flag sets: `bitflags`, not enums or bare integers

For a *set* of independent on/off flags, an `enum` can't represent combinations and a bare `u32`
carries no meaning. Use the `bitflags` crate (`bitflags = "2"`) — a typed set with `|`/`&`,
`contains`, and derived `Debug`:

```rust
use bitflags::bitflags;

bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Permissions: u32 {
        const READ  = 0b001;
        const WRITE = 0b010;
        const EXEC  = 0b100;
    }
}

let p = Permissions::READ | Permissions::WRITE;
if p.contains(Permissions::WRITE) { /* ... */ }
```

Use an `enum` only when the cases are mutually exclusive (exactly one at a time). → C-BITFLAG.

## Don't bound the type definition — bound the impl

```rust
struct Cache<T: Hash + Eq> { map: HashMap<T, u32> }   // ✗ bound leaks into every mention of Cache<T>
struct Cache<T> { map: HashMap<T, u32> }              // ✓ bare data definition
impl<T: Hash + Eq> Cache<T> { /* require the bound only where you use it */ }
```

A bound on a struct/enum *definition* buys nothing — you still repeat it on every `impl` — but it
*does* force the bound onto every signature that names the type, and loosening it later is a
breaking change. Keep the data definition bare; put bounds on the `impl`s and `where` clauses.
(Exception: a bound the layout genuinely needs, e.g. `T: ?Sized`.) → C-STRUCT-BOUNDS.

## Keep fields private; expose via methods

A `pub` field is a permanent commitment: you can't add an invariant, change the representation, or
`#[non_exhaustive]` it later without a breaking change. Default struct fields to private and expose
constructors/accessors; a newtype's inner field is private precisely so its invariant holds
(→ Newtype above). The semver mechanics → `rust-ecosystem` (libraries). → C-STRUCT-PRIVATE /
C-NEWTYPE-HIDE.
