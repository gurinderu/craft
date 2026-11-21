//! The structural search's syntax: a Rust file's tree, its nodes, and a path's segments as
//! written.

use tree_sitter::{Node, ParseOptions, ParseState, Parser, Tree};

/// The syntax tree of the Rust source `text`; `None` when `stop` asks the parse to end first.
pub(in crate::consumers::names) fn parse(
    text: &str,
    stop: &mut dyn FnMut() -> bool,
) -> Option<Tree> {
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

pub(super) fn text_of<'a>(n: Node<'_>, src: &'a str) -> &'a str {
    src.get(n.byte_range()).unwrap_or_default()
}

/// Every node under `root`, parents first.
pub(super) fn walk<'t>(root: Node<'t>, mut each: impl FnMut(Node<'t>)) {
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

/// The segments of a path or type as written: `a::T<X>` is `[a, T]`, `::a::T` `[::, a, T]`;
/// `None` for any other form (`<T as Tr>::x`).
pub(super) fn segs<'a>(n: Node<'_>, src: &'a str) -> Option<Vec<&'a str>> {
    match n.kind() {
        "identifier" | "type_identifier" | "self" | "super" | "crate" => {
            Some(vec![text_of(n, src)])
        }
        "scoped_identifier" | "scoped_type_identifier" => {
            let name = n.child_by_field_name("name")?;
            let mut out = match n.child_by_field_name("path") {
                Some(p) => segs(p, src)?,
                None => vec!["::"],
            };
            out.push(text_of(name, src));
            Some(out)
        }
        "generic_type" => segs(n.child_by_field_name("type")?, src),
        _ => None,
    }
}

/// The inline modules (`mod m { … }`) around `n`, outermost first.
pub(super) fn chain(n: Node<'_>, src: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut up = n.parent();
    while let Some(p) = up {
        if p.kind() == "mod_item"
            && let Some(name) = p.child_by_field_name("name")
        {
            out.push(text_of(name, src).to_owned());
        }
        up = p.parent();
    }
    out.reverse();
    out
}

/// Whether `n` sits in a `use` declaration.
pub(super) fn in_use(n: Node<'_>) -> bool {
    let mut up = n.parent();
    while let Some(p) = up {
        if p.kind() == "use_declaration" {
            return true;
        }
        up = p.parent();
    }
    false
}
