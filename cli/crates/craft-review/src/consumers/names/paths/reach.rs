//! The paths of one file that reach a changed item through its owner: a qualifier naming it (or a
//! `use … as` alias) not through another crate, or `Self` inside an `impl` (or the trait) it is.

use std::collections::BTreeSet;

use tree_sitter::{Node, Tree};

use super::imports::{Externals, imports};
use super::{Owner, first, segment, text_of, walk};

/// The lines (1-based, ascending) of `text` whose paths reach `name` declared in `own`, a path
/// starting with one of `ext` left out.
pub(in crate::consumers::names) fn reaching(
    tree: &Tree,
    text: &str,
    (name, own): (&str, &Owner),
    ext: &Externals,
) -> Vec<u32> {
    let r = Reach::new(tree, text, (name, own), ext);
    let mut rows = BTreeSet::new();
    walk(tree.root_node(), |n| match n.kind() {
        "scoped_identifier" if r.path(n) => {
            rows.insert(n.start_position().row);
        }
        "token_tree" => rows.extend(r.in_tokens(n)),
        _ => {}
    });
    rows.into_iter()
        .filter_map(|row| u32::try_from(row + 1).ok())
        .collect()
}

/// One file's question: which paths reach `name` declared in `own`.
struct Reach<'a> {
    src: &'a str,
    name: &'a str,
    own: &'a Owner,
    ext: &'a Externals,
    /// The names a single-segment qualifier reaches the owner by: its own, unless the file brings
    /// that name in from another crate, and each alias a `use` from this one gives it.
    aliases: BTreeSet<String>,
    /// The local names the file brings in from another crate.
    foreign: BTreeSet<String>,
}

impl<'a> Reach<'a> {
    fn new(
        tree: &Tree,
        src: &'a str,
        (name, own): (&'a str, &'a Owner),
        ext: &'a Externals,
    ) -> Self {
        let base = own.name();
        let mut aliases = BTreeSet::from([base.to_owned()]);
        let mut foreign = BTreeSet::new();
        for i in imports(tree, src) {
            if ext.leaves(&i.root) {
                foreign.insert(i.local);
            } else if i.last == base {
                aliases.insert(i.local);
            }
        }
        if foreign.contains(base) {
            aliases.remove(base);
        }
        Self {
            src,
            name,
            own,
            ext,
            aliases,
            foreign,
        }
    }

    /// Whether a qualifier whose last segment is `last`, read at `at`, names the owner: `Self`
    /// inside it; a single segment it goes by here; or a longer path, not through another crate,
    /// ending in its name or an alias. `start` is the path's first segment, `None` for one segment.
    fn names_owner(&self, last: &str, start: Option<&str>, at: Node<'_>) -> bool {
        match start {
            None if last == "Self" => self.inside_owner(at),
            None => self.aliases.contains(last),
            Some(s) => {
                let out = self.ext.leaves(s) || self.foreign.contains(s);
                !out && (last == self.own.name() || self.aliases.contains(last))
            }
        }
    }

    /// Whether the type `t` as written names the owner.
    fn type_names_owner(&self, t: Node<'_>, at: Node<'_>) -> bool {
        segment(t, self.src).is_some_and(|last| self.names_owner(last, first(t, self.src), at))
    }

    /// Whether `Self` at `at` is the owner: the nearest `impl` around it is of the type (or of
    /// the trait), or the trait around it is the trait.
    fn inside_owner(&self, at: Node<'_>) -> bool {
        let mut up = at.parent();
        while let Some(n) = up {
            let field = match (n.kind(), self.own) {
                ("impl_item", Owner::Type { .. }) => "type",
                ("impl_item", Owner::Trait(_)) => "trait",
                ("trait_item", Owner::Trait(_)) => "name",
                ("trait_item", Owner::Type { .. }) => return false,
                _ => {
                    up = n.parent();
                    continue;
                }
            };
            let seg = n
                .child_by_field_name(field)
                .and_then(|f| segment(f, self.src));
            return seg.is_some_and(|s| s == self.own.name() || self.aliases.contains(s));
        }
        false
    }

    /// Whether the path `n` (`a::b::name`) ends in the name through the owner.
    fn path(&self, n: Node<'_>) -> bool {
        let named = n.child_by_field_name("name").map(|i| text_of(i, self.src)) == Some(self.name);
        let Some(path) = n.child_by_field_name("path").filter(|_| named) else {
            return false;
        };
        if path.kind() == "bracketed_type" {
            return path.named_child(0).is_some_and(|q| self.qualified(q, n));
        }
        self.type_names_owner(path, n)
    }

    /// Whether `<q>::name` reaches the owner: `<T as Tr>` reaches `impl Tr for T`'s item and the
    /// trait `Tr`'s, never an inherent item of `T`; `<T>` reaches `T`'s.
    fn qualified(&self, q: Node<'_>, at: Node<'_>) -> bool {
        if q.kind() != "qualified_type" {
            return matches!(self.own, Owner::Type { .. }) && self.type_names_owner(q, at);
        }
        let part = |f: &str| q.child_by_field_name(f);
        let (Some(ty), Some(tr)) = (part("type"), part("alias")) else {
            return false;
        };
        match self.own {
            Owner::Type { of_trait: None, .. } => false,
            Owner::Type {
                of_trait: Some(t), ..
            } => self.type_names_owner(ty, at) && segment(tr, self.src) == Some(t.as_str()),
            Owner::Trait(_) => self.type_names_owner(tr, at),
        }
    }
}

mod tokens;
