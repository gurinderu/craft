# Dispatch: static, dynamic, and enum

Three ways to be polymorphic over a trait. They differ in *when* the method is resolved and
*what it costs*.

## 1. Static — generics / `impl Trait`

The compiler generates a specialized copy per concrete type (**monomorphization**). Calls are
direct and inlinable — zero runtime overhead.

```rust
fn draw_all<T: Shape>(shapes: &[T]) {       // one copy of draw_all per T
    for s in shapes { s.draw(); }           // direct call, inlinable
}
```

- ✅ fastest; no allocation; no indirection
- ❌ one concrete type per instantiation — a `Vec<T>` is **homogeneous**
- ❌ code bloat (a copy per type); slower compiles

Use when the type is known at the call site and you want maximum speed.

## 2. Dynamic — `dyn Trait`

One copy of the code; the concrete method is found at runtime through a **vtable**. Lets you mix
types and stay open to new ones.

```rust
let shapes: Vec<Box<dyn Shape>> = vec![     // heterogeneous, open set
    Box::new(Circle { r: 1.0 }),
    Box::new(Square { s: 2.0 }),
];
for s in &shapes { s.draw(); }              // virtual call via vtable
```

- ✅ heterogeneous collections; **open** — new impls need no change to existing code
- ✅ smaller binary, faster compiles
- ❌ pointer indirection, no inlining; usually a heap allocation (`Box`)
- ❌ **object-safety** constraints (below); loses the concrete type

Use for plugin-style extensibility or genuinely open type sets.

### Object safety (dyn-compatibility)

A trait can be `dyn` only if methods are callable through a pointer: **no generic methods**, no
`Self` by value in return position, no associated consts, etc. A method bounded by
`where Self: Sized` is exempt — it's simply unavailable on the trait object, but the trait stays
dyn-compatible (this is how std's `Iterator` adapters like `map`/`filter` coexist with
`dyn Iterator`). Some features make a trait **not** dyn-compatible outright: a `Clone` supertrait
(`Clone: Sized`), and return-position `impl Trait` in traits or `async fn` in traits (RPITIT —
both desugar to an associated type that can't be named through a vtable). When you hit E0038, the
trait isn't object-safe — gate the offending methods with `where Self: Sized`, or switch to
generics or enum dispatch.

## 3. Enum dispatch — the static, closed middle ground

When the set of implementors is **known and fixed**, wrap them in an enum and implement the
trait by matching. You get static dispatch and stack allocation *with* heterogeneous storage.

```rust
enum Shape { Circle(Circle), Square(Square) }   // the closed set

impl Shape {
    fn draw(&self) {
        match self {                            // dispatch by match — static, inlinable
            Shape::Circle(c) => c.draw(),
            Shape::Square(s) => s.draw(),
        }
    }
}

let shapes = vec![Shape::Circle(Circle { r: 1.0 }), Shape::Square(Square { s: 2.0 })];
for s in &shapes { s.draw(); }              // no Box, no vtable
```

- ✅ no allocation — `Vec<Shape>` lives on the stack/inline; no vtable; inlinable
- ✅ heterogeneous; the concrete type is recoverable via `match`
- ✅ `#[derive(Clone, PartialEq, …)]` just works on the enum
- ✅ adding/removing a variant is a **compile error** at every `match` — exhaustiveness keeps
  you honest (this is a feature for a closed domain)
- ❌ boilerplate: a `match` arm per method per variant
- ❌ closed: external code can't add a variant (that's exactly when you'd want `dyn` instead)

### Kill the boilerplate — `enum_dispatch`

The [`enum_dispatch`](https://crates.io/crates/enum_dispatch) crate generates the enum and the
delegating `match` arms from the trait:

```toml
[dependencies]
enum_dispatch = "0.3"
```

```rust
use enum_dispatch::enum_dispatch;

#[enum_dispatch]
trait Shape { fn draw(&self); }

#[enum_dispatch(Shape)]          // generates the enum's Shape impl, matching each variant
enum AnyShape { Circle, Square } // variants named by their type

impl Shape for Circle { fn draw(&self) { /* ... */ } }
impl Shape for Square { fn draw(&self) { /* ... */ } }
```

It compiles to the same `match` you'd hand-write — static dispatch, no `Box` — and benchmarks
typically beat `dyn` on hot paths.

## Choosing

```
Is the set of types open (others add their own)?
  yes → dyn Trait
  no  → Is the type fixed at each call site (homogeneous)?
          yes → generics / impl Trait        (fastest, simplest)
          no  → enum dispatch                 (heterogeneous, no alloc, closed)
```

Rules of thumb: **generics** by default; **enum dispatch** when you need a mixed collection of a
known set and care about speed/allocation; **`dyn`** when the set must stay open or object
safety/compile-time/binary-size pushes you there.

## Operations over a variant set — the Visitor question

When you have a set of variants and want to run operations over them, the dispatch choice above
decides how — this is the classic Visitor pattern, and Rust answers it by whether the set is
**closed** or **open**:

- **Closed set → `match` on an enum.** Add a new operation freely (just write another function that
  matches). Adding a variant is a compile error at every `match` — a breaking change you *want* the
  compiler to surface. This is enum dispatch (above); no visitor trait needed.

```rust
enum Expr { Lit(i64), Add(Box<Expr>, Box<Expr>) }

fn eval(e: &Expr) -> i64 {                  // a new operation is just a new fn — no trait, no double dispatch
    match e {
        Expr::Lit(n) => *n,
        Expr::Add(a, b) => eval(a) + eval(b),
    }
}
```

- **Open set → a visitor trait (double dispatch).** When external code must add new node types
  without touching yours, expose a `Visitor` trait and have each node call back into it: new node
  types implement `accept`, new operations are new `Visitor` impls.

```rust
trait Visitor { fn visit_lit(&mut self, n: i64); fn visit_add(&mut self, a: &dyn Node, b: &dyn Node); }
trait Node    { fn accept(&self, v: &mut dyn Visitor); }
```

Reach for the trait only when the set is genuinely open — for your own closed AST a plain `match`
is simpler and exhaustiveness-checked. For walking large or generated ASTs, a derive macro can
generate the `accept`/visit plumbing → `rust-macros`.
