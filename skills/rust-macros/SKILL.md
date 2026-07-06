---
name: rust-macros
description: >-
  Rust metaprogramming — declarative macros (macro_rules!) and procedural macros (derive, attribute, function-like) with syn/quote, plus when a macro is the wrong tool. Use when writing or debugging a macro, generating boilerplate, building a derive, or deciding macro vs generics. Triggers: macro_rules!, proc macro, derive macro, syn, quote, cargo expand, ToTokens, DSL.
---

# Rust Macros

Macros generate code at compile time. They're powerful and **easy to overuse** — they hurt
readability, tooling, and compile times, and they're harder to debug than ordinary code. Reach
for them only when functions, generics, and traits genuinely can't express the thing. Procedural
macros are in [proc-macros.md](proc-macros.md).

## When to Use

- Eliminating boilerplate that *can't* be a function/generic (varies in arity or by type shape)
- A custom `#[derive(...)]` for your trait
- A small embedded DSL (`vec!`-like, builder syntax)
- Annotating items to transform/register them (attribute macros)

## First: do you actually need a macro?

Escalate up this ladder and stop at the first rung that works — each step costs more:

```
1. a function                  — runtime values
2. generics + traits           — same code over many types (→ rust-traits)
3. macro_rules! (declarative)  — same SYNTAX over many forms; variadic; light DSL
4. a procedural macro          — parse/transform arbitrary tokens; custom derive
```

Most "I need a macro" is really **generics** (rung 2). A macro that just calls a function with
fixed args is a function. Don't pay the macro tax for something the type system already does.

## Declarative macros — `macro_rules!`

Pattern-match on syntax and expand. Good for variadic helpers and reducing repetitive call sites.

```rust
macro_rules! hashmap {
    ($($key:expr => $val:expr),* $(,)?) => {{   // trailing-comma tolerant
        let mut m = std::collections::HashMap::new();
        $( m.insert($key, $val); )*             // repetition expands per element
        m
    }};
}
let m = hashmap!{ "a" => 1, "b" => 2 };
```

- **Fragment specifiers** name what a metavariable matches: `expr`, `ident`, `ty`, `pat`, `tt`,
  `literal`, `block`, `path`, … Choose the tightest one (`tt` is the catch-all, last resort).
- **Repetition**: `$(...)* / + / ?` with a separator, mirrored in the body.
- **Hygiene**: identifiers you introduce don't collide with the caller's — a real safety feature
  declarative macros give you for free.
- Export with `#[macro_export]` (it lands at crate root).

Use `macro_rules!` when the variation is in the *syntax/shape*; if you need to *inspect types,
fields, or generate impls from a struct's definition*, you've outgrown it → procedural macros.

## See what a macro expands to

The #1 debugging tool — read the generated code:

```bash
cargo install cargo-expand
cargo expand path::to::module        # prints the post-macro source
```

When a macro misbehaves, expand it first; the bug is almost always visible in the output.

## Boundaries

- Procedural macros (derive/attribute/function-like, `syn`/`quote`, errors, testing) →
  [proc-macros.md](proc-macros.md).
- "Same logic over many types" without code generation → `rust-traits` (generics/traits first).
- A macro that emits `unsafe` carries the same obligations → `rust-unsafe`.
