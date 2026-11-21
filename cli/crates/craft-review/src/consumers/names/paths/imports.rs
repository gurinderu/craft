//! What one file's `use` declarations bring in: each name with the full path it comes by, and
//! each glob, read in the inline module the declaration sits in — `{self as x}` and `*` included
//! (realm @nick/craft, #564).

use tree_sitter::{Node, Tree};

use super::syntax::{chain, segs, text_of, walk};

/// One `use` leaf: the inline modules around it, the local name it binds (`None` for a glob) and
/// the path as written (a glob's, the module it reads).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Import {
    pub chain: Vec<String>,
    pub local: Option<String>,
    pub path: Vec<String>,
}

/// Every name and glob the file's `use` declarations bring in.
pub(super) fn imports(tree: &Tree, src: &str) -> Vec<Import> {
    let mut out = Vec::new();
    walk(tree.root_node(), |n| {
        if n.kind() == "use_declaration"
            && let Some(arg) = n.child_by_field_name("argument")
        {
            let at = Leaf {
                chain: chain(n, src),
                src,
            };
            at.leaves(arg, &[], &mut out);
        }
    });
    out
}

/// Whether the file's own module brings `name` in by a `use` — by name, or a glob — and declares
/// no item of it at its top: a re-export of it.
pub(in crate::consumers::names) fn reexports(tree: &Tree, src: &str, name: &str) -> bool {
    let root = tree.root_node();
    let mut c = root.walk();
    let declared = root.named_children(&mut c).any(|n| {
        n.kind() != "use_declaration"
            && n.child_by_field_name("name")
                .is_some_and(|i| text_of(i, src) == name)
    });
    let brought = imports(tree, src)
        .iter()
        .any(|i| i.chain.is_empty() && i.local.as_deref().is_none_or(|l| l == name));
    brought && !declared
}

/// Where a `use` tree is read: the inline modules around it and the file's text.
struct Leaf<'a> {
    chain: Vec<String>,
    src: &'a str,
}

impl Leaf<'_> {
    /// `prefix` followed by the path `n` as written, a trailing `self` dropped (`a::{self}` is `a`).
    fn path(&self, prefix: &[String], n: Option<Node<'_>>) -> Option<Vec<String>> {
        let mut out = prefix.to_vec();
        if let Some(n) = n {
            out.extend(segs(n, self.src)?.into_iter().map(str::to_owned));
        }
        if out.last().is_some_and(|l| l == "self") {
            out.pop();
        }
        (!out.is_empty()).then_some(out)
    }

    fn add(&self, out: &mut Vec<Import>, local: Option<&str>, path: Vec<String>) {
        out.push(Import {
            chain: self.chain.clone(),
            local: local.map(str::to_owned),
            path,
        });
    }

    /// The names and globs `n`, a part of a `use` tree under `prefix`, brings in.
    fn leaves(&self, n: Node<'_>, prefix: &[String], out: &mut Vec<Import>) {
        match n.kind() {
            "identifier" | "scoped_identifier" | "self" | "crate" | "super" => {
                if let Some(path) = self.path(prefix, Some(n)) {
                    let local = path.last().cloned();
                    self.add(out, local.as_deref(), path);
                }
            }
            "use_as_clause" => {
                let alias = n.child_by_field_name("alias").map(|a| text_of(a, self.src));
                if let (Some(path), Some(alias)) =
                    (self.path(prefix, n.child_by_field_name("path")), alias)
                {
                    self.add(out, Some(alias), path);
                }
            }
            "use_wildcard" => {
                if let Some(path) = self.path(prefix, n.named_child(0)) {
                    self.add(out, None, path);
                }
            }
            "scoped_use_list" => {
                let inner = self.path(prefix, n.child_by_field_name("path"));
                if let Some(list) = n.child_by_field_name("list") {
                    self.leaves(list, inner.as_deref().unwrap_or(prefix), out);
                }
            }
            "use_list" => {
                let mut c = n.walk();
                for item in n.named_children(&mut c) {
                    self.leaves(item, prefix, out);
                }
            }
            _ => {}
        }
    }
}
