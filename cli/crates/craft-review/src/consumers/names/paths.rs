//! The structural search's reading of one Rust file (realm @nick/craft, node #529): what a changed
//! item is declared in, and the lines whose paths reach it — `T::name`, `Self::name` inside an
//! `impl` of `T`, `<T as Tr>::name`, `Tr::name` for a trait's item, a `use … as` alias of the
//! owner — read from the tree-sitter syntax tree, so comments, strings and other types' items of
//! the name never match. A call through a value (`x.name()`) carries no type and is not read.

use tree_sitter::{Node, ParseOptions, ParseState, Parser, Tree};

/// What a changed item is declared in, by the last path segment that names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Owner {
    /// `impl T` or `impl Tr for T`: the type `T`.
    Type(String),
    /// `trait Tr`.
    Trait(String),
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

/// What the function `name` declared on `line` (1-based) of `text` is declared in: an `impl`'s
/// type or a trait; `None` for a free item, or when no function of that name starts there.
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
        "impl_item" => Some(Owner::Type(
            segment(holder.child_by_field_name("type")?, text)?.to_owned(),
        )),
        "trait_item" => Some(Owner::Trait(
            text_of(holder.child_by_field_name("name")?, text).to_owned(),
        )),
        _ => None,
    }
}

mod reach;

pub(super) use reach::reaching;

#[cfg(test)]
#[path = "paths_tests.rs"]
mod tests;
