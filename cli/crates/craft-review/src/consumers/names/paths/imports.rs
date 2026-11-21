//! Which path roots lead out of the workspace, and what one file's `use` declarations bring in
//! from where: a path through another crate never reaches a changed item of this one.

use std::collections::BTreeSet;

use tree_sitter::{Node, Tree};

use super::{first, segment, text_of, walk};

/// The crates outside the workspace a path can start with: the standard ones and the workspace's
/// dependencies that are not its own members.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::consumers) struct Externals {
    crates: BTreeSet<String>,
}

impl Default for Externals {
    fn default() -> Self {
        Self::of(std::iter::empty::<String>())
    }
}

impl Externals {
    /// The standard crates and `deps`, each as code spells it (`-` as `_`).
    pub(in crate::consumers::names) fn of(deps: impl IntoIterator<Item = String>) -> Self {
        let std = ["std", "core", "alloc"].map(str::to_owned);
        let crates = std
            .into_iter()
            .chain(deps.into_iter().map(|d| d.replace('-', "_")))
            .collect();
        Self { crates }
    }

    /// Whether a path starting with `root` leaves the workspace: `::` (the 2018 edition's
    /// extern-crate root) or an external crate's name.
    pub(super) fn leaves(&self, root: &str) -> bool {
        root == "::" || self.crates.contains(root)
    }
}

/// One name a `use` brings into a file: its local name, the first segment of the path it comes
/// by, and the last segment it names.
pub(super) struct Import {
    pub local: String,
    pub root: String,
    pub last: String,
}

/// Every name the file's `use` declarations bring in.
pub(super) fn imports(tree: &Tree, src: &str) -> Vec<Import> {
    let mut out = Vec::new();
    walk(tree.root_node(), |n| {
        if n.kind() == "use_declaration"
            && let Some(arg) = n.child_by_field_name("argument")
        {
            leaves(arg, None, src, &mut out);
        }
    });
    out
}

fn add(out: &mut Vec<Import>, (local, root, last): (&str, &str, &str)) {
    out.push(Import {
        local: local.to_owned(),
        root: root.to_owned(),
        last: last.to_owned(),
    });
}

/// The names `n`, a part of a `use` tree under the path root `root` (none at its top), brings in.
fn leaves(n: Node<'_>, root: Option<&str>, src: &str, out: &mut Vec<Import>) {
    let root_of = |p: Node<'_>| root.or_else(|| first(p, src)).unwrap_or(text_of(p, src));
    match n.kind() {
        "identifier" | "scoped_identifier" => {
            if let Some(last) = segment(n, src) {
                add(out, (last, root_of(n), last));
            }
        }
        "use_as_clause" => {
            let (Some(p), Some(alias)) = (
                n.child_by_field_name("path"),
                n.child_by_field_name("alias"),
            ) else {
                return;
            };
            if let Some(last) = segment(p, src) {
                add(out, (text_of(alias, src), root_of(p), last));
            }
        }
        "scoped_use_list" => {
            let path = n.child_by_field_name("path");
            let inner = path.map_or(root.unwrap_or("::"), root_of);
            let Some(list) = n.child_by_field_name("list") else {
                return;
            };
            let mut c = list.walk();
            for item in list.named_children(&mut c) {
                if item.kind() == "self" {
                    if let Some(last) = path.and_then(|p| segment(p, src)) {
                        add(out, (last, inner, last));
                    }
                } else {
                    leaves(item, Some(inner), src, out);
                }
            }
        }
        "use_list" => {
            let mut c = n.walk();
            for item in n.named_children(&mut c) {
                leaves(item, root, src, out);
            }
        }
        _ => {}
    }
}
