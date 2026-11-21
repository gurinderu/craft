//! What a changed function is declared in: an `impl`'s type, a trait, or a module, each by its
//! full path (realm @nick/craft, #564).

use tree_sitter::{Node, Tree};

use super::syntax::{segs, text_of, walk};
use super::{Item, Kind, Owner, Resolver};

/// Whether `ty`, an `impl`'s type, is one of `imp`'s own type parameters (a blanket `impl<T> Tr
/// for T`).
fn is_parameter(imp: Node<'_>, ty: &[&str], src: &str) -> bool {
    let ([ty], Some(params)) = (ty, imp.child_by_field_name("type_parameters")) else {
        return false;
    };
    let mut c = params.walk();
    params.named_children(&mut c).any(|p| {
        let name = p.child_by_field_name("name").or_else(|| p.named_child(0));
        name.is_some_and(|n| text_of(n, src) == *ty)
    })
}

/// The function `name` declared on `line` (1-based) of `text`.
fn function<'t>(tree: &'t Tree, text: &str, line: u32, name: &str) -> Option<Node<'t>> {
    let row = usize::try_from(line).ok()?.checked_sub(1)?;
    let mut found = None;
    walk(tree.root_node(), |n| {
        let is_fn = matches!(n.kind(), "function_item" | "function_signature_item");
        let named = n.child_by_field_name("name").map(|i| text_of(i, text)) == Some(name);
        if found.is_none() && is_fn && n.start_position().row == row && named {
            found = Some(n);
        }
    });
    found
}

/// What the function `name` declared on `line` (1-based) of `text` is declared in, read by `res`:
/// an `impl`'s type, a trait (no implementor found yet), or a module for a free function; `None`
/// for a blanket `impl` over a type parameter, a function inside another's body, or when no
/// function of that name starts there.
pub(in crate::consumers::names) fn owner(
    tree: &Tree,
    text: &str,
    (line, name): (u32, &str),
    res: &Resolver<'_>,
) -> Option<Owner> {
    let f = function(tree, text, line, name)?;
    let parent = f.parent()?;
    let holder = match parent.kind() {
        "source_file" => parent,
        "declaration_list" => parent.parent()?,
        _ => return None,
    };
    let in_module = |n: Node<'_>, last: &str| {
        let mut at = res.module_at(n);
        at.path.push(last.to_owned());
        at
    };
    match holder.kind() {
        "source_file" | "mod_item" => Some(Owner {
            kind: Kind::Free,
            at: in_module(f, name),
        }),
        "impl_item" => {
            let ty = segs(holder.child_by_field_name("type")?, text)?;
            let at = res.resolve(holder, &ty).into_iter().next()?;
            let of_trait = holder
                .child_by_field_name("trait")
                .and_then(|t| segs(t, text)?.last().map(|s| (*s).to_owned()));
            (!is_parameter(holder, &ty, text)).then_some(Owner {
                kind: Kind::Type { of_trait },
                at,
            })
        }
        "trait_item" => Some(Owner {
            kind: Kind::Trait { impls: Vec::new() },
            at: in_module(holder, text_of(holder.child_by_field_name("name")?, text)),
        }),
        _ => None,
    }
}

/// The types `impl` items of `tree` implement the trait at `trait_at` for, read by `res`; a
/// path through an enclosing module reaches the trait as [`super::same`] has it.
pub(in crate::consumers::names) fn implementors(
    tree: &Tree,
    text: &str,
    (trait_at, rx): (&Item, super::Reexports<'_>),
    res: &Resolver<'_>,
) -> Vec<Item> {
    let mut out = Vec::new();
    walk(tree.root_node(), |n| {
        if n.kind() != "impl_item" {
            return;
        }
        let path = |field: &str| n.child_by_field_name(field).and_then(|t| segs(t, text));
        let (Some(tr), Some(ty)) = (path("trait"), path("type")) else {
            return;
        };
        let of = res.resolve(n, &tr);
        if !is_parameter(n, &ty, text) && of.iter().any(|t| super::same(t, trait_at, rx)) {
            out.extend(res.resolve(n, &ty).into_iter().take(1));
        }
    });
    out
}
