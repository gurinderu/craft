# Procedural macros

When you need to **parse** Rust tokens and **generate** code from them — a custom derive, an
attribute that rewrites an item, or a function-like macro with non-trivial syntax. Proc macros
must live in their own crate marked `proc-macro = true`.

```toml
# in the proc-macro crate's Cargo.toml
[lib]
proc-macro = true

[dependencies]
syn = { version = "2", features = ["full"] }   # parse tokens into a typed AST
quote = "1"                                     # generate tokens from a template
proc-macro2 = "1"                               # the testable token type
```

## The three kinds

| Kind | Invoked as | For |
|---|---|---|
| **derive** | `#[derive(MyTrait)]` | generate a trait impl from a type's definition |
| **attribute** | `#[my_attr] fn f()` | transform/annotate the item it's on |
| **function-like** | `my_macro!(...)` | arbitrary token input, like `macro_rules!` but full parsing |

## Derive macro — the common case

Parse the annotated item with `syn`, build the impl with `quote`:

```rust
use proc_macro::TokenStream;
use quote::quote;
use syn::{parse_macro_input, DeriveInput};

#[proc_macro_derive(Hello)]
pub fn derive_hello(input: TokenStream) -> TokenStream {
    let ast = parse_macro_input!(input as DeriveInput);
    let name = &ast.ident;
    let (impl_g, ty_g, where_c) = ast.generics.split_for_impl();   // carry generics through!

    quote! {
        impl #impl_g Hello for #name #ty_g #where_c {
            fn hello(&self) -> String { format!("hello from {}", stringify!(#name)) }
        }
    }.into()
}
```

`#name` interpolates a parsed value into the generated tokens. Always thread the type's generics
(`split_for_impl`) or the impl won't compile for generic types.

(Paths kept bare for brevity; real macros should use `::std`/`::core` absolute paths — see
[Hygiene & pitfalls](#hygiene--pitfalls).)

## Good errors — don't `panic!`

A proc macro's `panic!` gives the user a useless message with no span. Emit a real compile error
pointed at the offending tokens:

```rust
use syn::spanned::Spanned;
return syn::Error::new(field.span(), "expected a named field").to_compile_error().into();
```

`syn::Error` carries a **span**, so the error underlines the right code. Good diagnostics are
what separate a usable macro from a frustrating one.

## Parsing attributes — `darling`

Hand-parsing `#[my(name = "x", skip)]` with `syn` is tedious. `darling` (`darling = "0.23"`)
derives the parser from a struct, with validation and error spans for free — use it for any
non-trivial attribute input.

## Hygiene & pitfalls

- **Use absolute paths** in generated code: `::std::string::String`, `::core::result::Result` —
  the call site may not have them imported (or may have shadowed them).
- **Don't hardcode your crate's name** for referring back to it — users may rename it; use
  `proc-macro-crate` to resolve it.
- proc-macro2's `TokenStream` is the testable one; convert at the `proc_macro` boundary only.
- Macros inflate compile times and obscure tooling — keep the generated code small and boring.

## Testing

- **`cargo expand`** — eyeball the expansion (the first thing to do when it's wrong).
- **`trybuild`** (`trybuild = "1"`) — assert that *good* input compiles and *bad* input fails with
  the expected error message (compile-fail tests) — the standard way to test proc macros and
  their diagnostics:

```rust
#[test]
fn ui() {
    let t = trybuild::TestCases::new();
    t.pass("tests/ui/ok.rs");
    t.compile_fail("tests/ui/bad.rs");   // checks the error text in tests/ui/bad.stderr
}
```

- Put the actual trait + the proc-macro crate behind one facade crate that re-exports both, so
  users depend on a single crate (common pattern: `mycrate` re-exports `mycrate-derive`).
