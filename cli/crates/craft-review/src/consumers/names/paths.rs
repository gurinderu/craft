//! The structural search's reading of one Rust file (realm @nick/craft, node #529): what a changed
//! item is declared in, and the lines whose paths reach it — `T::name`, `Self::name` inside an
//! `impl` of `T`, `<T as Tr>::name`, `Tr::name` for a trait's item, a `use … as` alias of the
//! owner — read from the tree-sitter syntax tree, so comments, strings and items of the name
//! reached through another crate never match. A call through a value (`x.name()`) carries no type
//! and is not read; a same-named type in another module of the same crate can match (#564).

use tree_sitter::{Node, ParseOptions, ParseState, Parser, Tree};

mod imports;
mod reach;

pub(in crate::consumers) use imports::Externals;
pub(super) use reach::reaching;

/// What a changed item is declared in, by the last path segment that names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Owner {
    /// `impl T` (`of_trait` none) or `impl Tr for T` (`of_trait` the trait `Tr`): the type `T`.
    Type {
        name: String,
        of_trait: Option<String>,
    },
    /// `trait Tr`.
    Trait(String),
}

impl Owner {
    /// The name the owner is declared by.
    pub(super) fn name(&self) -> &str {
        match self {
            Self::Type { name, .. } | Self::Trait(name) => name,
        }
    }
}

/// The syntax tree of the Rust source `text`; `None` when `stop` asks the parse to end first.
pub(super) fn parse(text: &str, stop: &mut dyn FnMut() -> bool) -> Option<Tree> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_rust::LANGUAGE.into())
        .ok()?;
    let bytes = text.as_bytes();
    let mut progress = |_: &ParseState| stop();
    let options = ParseOptions::new().progress_callback(&mut progress);
    parser.parse_with_options(
        &mut |i, _| bytes.get(i..).unwrap_or_default(),
        None,
        Some(options),
    )
}

fn text_of<'a>(n: Node<'_>, src: &'a str) -> &'a str {
    src.get(n.byte_range()).unwrap_or_default()
}

/// Every node under `root`, parents first.
fn walk<'t>(root: Node<'t>, mut each: impl FnMut(Node<'t>)) {
    let mut c = root.walk();
    loop {
        each(c.node());
        if c.goto_first_child() {
            continue;
        }
        while !c.goto_next_sibling() {
            if !c.goto_parent() {
                return;
            }
        }
    }
}

/// The last segment of a path or type as written: `a::T<X>` is `T`.
fn segment<'a>(n: Node<'_>, src: &'a str) -> Option<&'a str> {
    match n.kind() {
        "identifier" | "type_identifier" => Some(text_of(n, src)),
        "scoped_identifier" | "scoped_type_identifier" => {
            segment(n.child_by_field_name("name")?, src)
        }
        "generic_type" => segment(n.child_by_field_name("type")?, src),
        _ => None,
    }
}

/// The first segment of a path or type as written (`a::b::T<X>` is `a`), `::` for a path from the
/// crate root (`::a::T`), and `None` for a single segment.
fn first<'a>(n: Node<'_>, src: &'a str) -> Option<&'a str> {
    let mut at = match n.kind() {
        "scoped_identifier" | "scoped_type_identifier" => n,
        "generic_type" => return first(n.child_by_field_name("type")?, src),
        _ => return None,
    };
    loop {
        let Some(path) = at.child_by_field_name("path") else {
            return Some("::");
        };
        match path.kind() {
            "scoped_identifier" | "scoped_type_identifier" => at = path,
            "generic_type" => return first(path, src).or(Some(text_of(path, src))),
            _ => return Some(text_of(path, src)),
        }
    }
}

/// Whether `ty`, an `impl`'s type, is one of `imp`'s own type parameters (a blanket `impl<T> Tr
/// for T`).
fn is_parameter(imp: Node<'_>, ty: &str, src: &str) -> bool {
    let Some(params) = imp.child_by_field_name("type_parameters") else {
        return false;
    };
    let mut c = params.walk();
    params.named_children(&mut c).any(|p| {
        let name = p.child_by_field_name("name").or_else(|| p.named_child(0));
        name.is_some_and(|n| text_of(n, src) == ty)
    })
}

/// What the function `name` declared on `line` (1-based) of `text` is declared in: an `impl`'s
/// type or a trait; `None` for a free item, a blanket `impl` over a type parameter, or when no
/// function of that name starts there.
pub(super) fn owner(tree: &Tree, text: &str, line: u32, name: &str) -> Option<Owner> {
    let row = usize::try_from(line).ok()?.checked_sub(1)?;
    let mut found = None;
    walk(tree.root_node(), |n| {
        let is_fn = matches!(n.kind(), "function_item" | "function_signature_item");
        let named = n.child_by_field_name("name").map(|i| text_of(i, text)) == Some(name);
        if found.is_none() && is_fn && n.start_position().row == row && named {
            found = Some(n);
        }
    });
    let holder = found?.parent()?.parent()?;
    match holder.kind() {
        "impl_item" => {
            let ty = segment(holder.child_by_field_name("type")?, text)?;
            let of_trait = holder.child_by_field_name("trait");
            (!is_parameter(holder, ty, text)).then(|| Owner::Type {
                name: ty.to_owned(),
                of_trait: of_trait.and_then(|t| segment(t, text)).map(str::to_owned),
            })
        }
        "trait_item" => Some(Owner::Trait(
            text_of(holder.child_by_field_name("name")?, text).to_owned(),
        )),
        _ => None,
    }
}

#[cfg(test)]
#[path = "paths_tests.rs"]
mod tests;
