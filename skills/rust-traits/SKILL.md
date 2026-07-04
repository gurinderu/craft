---
name: rust-traits
description: >-
  Rust traits, generics, and dispatch — trait bounds, impl Trait, static vs dynamic vs enum dispatch, object safety, and type-driven design (newtype, typestate, PhantomData, sealed traits). Use when designing an abstraction, choosing generics vs dyn vs enum, fixing trait-bound errors, or encoding invariants in the type system. Triggers: impl Trait, dyn, trait object, monomorphization, enum dispatch, associated type, object safety, newtype, typestate, PhantomData, sealed trait, E0277, E0308, E0599, E0038, E0119.
---

# Rust Traits & Generics

Traits define shared behavior; how you *dispatch* to it (static, dynamic, or enum) is the
decision that shapes performance and extensibility. Type-driven design then uses traits and
generics to make illegal states unrepresentable. Deep dives in the sub-files.

## When to Use

- Designing an abstraction over multiple types
- Choosing generics vs `dyn Trait` vs enum dispatch
- Fixing trait-bound / "method not found" / object-safety errors
- Encoding invariants in types (newtype, typestate, sealed traits)

## Quick model

```rust
trait Area { fn area(&self) -> f64; }       // shared behavior

fn total<T: Area>(items: &[T]) -> f64 {     // generic: monomorphized per T
    items.iter().map(Area::area).sum()
}

fn describe(s: &impl Area) -> String {      // impl Trait in arg = generic sugar
    format!("area {}", s.area())
}

fn make() -> impl Area { Circle { r: 1.0 } }// impl Trait in return = one opaque concrete type
```

Bounds go inline (`<T: Area + Clone>`) or in a `where` clause when they get long. Prefer
**associated types** when a trait has one natural output type per impl (`Iterator::Item`);
use **generic parameters** when a type can implement the trait many ways (`From<T>`).

## The dispatch decision

The central choice when you have several types behind one trait:

| Approach | Set of types | Layout | Cost | Pick when |
|---|---|---|---|---|
| Generics / `impl Trait` | one per call site (homogeneous) | monomorphized, inlinable | code bloat, no runtime cost | the type is known at compile time |
| `dyn Trait` (`Box<dyn>`, `&dyn`) | open, heterogeneous | vtable indirection, usually boxed | alloc + no inlining | **open** extensibility, plugins, `Vec` of mixed types |
| **enum dispatch** | **closed**, heterogeneous | enum on stack, `match` | a little boilerplate | a **known, fixed** set; hot path; `Vec` without `Box` |

Full treatment with code in [dispatch.md](dispatch.md) — including enum dispatch (and the
`enum_dispatch` crate) as the static, allocation-free middle ground between generics and `dyn`.

## Coherence (the orphan rule)

You may `impl Trait for Type` only if you own the trait **or** the type. To implement a foreign
trait on a foreign type, wrap it in a **newtype** (see [type-driven.md](type-driven.md)). This
is why E0119 / "only traits defined in the current crate" appears.

## Error → fix

| Error | Meaning | Fix |
|---|---|---|
| **E0277** | trait bound `T: Trait` not satisfied | add the bound, or `impl Trait for T` |
| **E0599** | method not found | bring the trait into scope (`use`), or a bound is missing |
| **E0308** | mismatched types | two `impl Trait` returns aren't the *same* type; box them or use an enum |
| **E0038** | trait is not object-safe (not dyn-compatible) | can't make `dyn` — use generics or **enum dispatch** ([dispatch.md](dispatch.md)) |
| **E0119** | conflicting/orphan impl | you don't own trait or type — use a newtype |

## Boundaries

- Lifetimes in bounds and references are mechanics of `rust-ownership`; this skill is the trait
  and generic system.
- The catalog of "idiomatic vs not" trait usage → `rust-idioms`.
- Using traits as **ports** to invert dependencies across an application → `rust-architecture`.
