//! The paths of one file that reach a changed item through its owner: a qualifier that names it
//! (or a `use … as` alias of it), or `Self` inside an `impl` (or the trait) it is.

use std::collections::BTreeSet;

use tree_sitter::{Node, Tree};

use super::{Owner, segment, text_of, walk};

/// The lines (1-based, ascending) of `text` whose paths reach `name` declared in `own`.
pub(in crate::consumers::names) fn reaching(
    tree: &Tree,
    text: &str,
    name: &str,
    own: &Owner,
) -> Vec<u32> {
    let r = Reach {
        src: text,
        name,
        own,
        aliases: aliases(tree, text, own),
    };
    let mut rows = BTreeSet::new();
    walk(tree.root_node(), |n| {
        let hit = match n.kind() {
            "scoped_identifier" => r.path(n).then_some(n),
            "token_tree" => r.in_tokens(n),
            _ => None,
        };
        rows.extend(hit.map(|h| h.start_position().row));
    });
    rows.into_iter()
        .filter_map(|row| u32::try_from(row + 1).ok())
        .collect()
}

/// The names the owner goes by in `text`: its own, and each `use … as` alias of it.
fn aliases(tree: &Tree, text: &str, own: &Owner) -> BTreeSet<String> {
    let base = match own {
        Owner::Type(t) | Owner::Trait(t) => t.as_str(),
    };
    let mut out = BTreeSet::from([base.to_owned()]);
    walk(tree.root_node(), |n| {
        if n.kind() != "use_as_clause" {
            return;
        }
        let path = n.child_by_field_name("path").and_then(|p| segment(p, text));
        if let (Some(base_of), Some(alias)) = (path, n.child_by_field_name("alias"))
            && base_of == base
        {
            out.insert(text_of(alias, text).to_owned());
        }
    });
    out
}

/// One file's question: which paths reach `name` declared in `own`.
struct Reach<'a> {
    src: &'a str,
    name: &'a str,
    own: &'a Owner,
    aliases: BTreeSet<String>,
}

impl Reach<'_> {
    /// Whether a qualifier `seg` read at `at` names the owner: by a name it goes by, or as `Self`
    /// inside an `impl` (or the trait) it is.
    fn names_owner(&self, seg: Option<&str>, at: Node<'_>) -> bool {
        match seg {
            Some("Self") => self.inside_owner(at),
            Some(s) => self.aliases.contains(s),
            None => false,
        }
    }

    /// Whether `Self` at `at` is the owner: the nearest `impl` around it is of the type (or of
    /// the trait), or the trait around it is the trait.
    fn inside_owner(&self, at: Node<'_>) -> bool {
        let mut up = at.parent();
        while let Some(n) = up {
            let field = match (n.kind(), self.own) {
                ("impl_item", Owner::Type(_)) => "type",
                ("impl_item", Owner::Trait(_)) => "trait",
                ("trait_item", Owner::Trait(_)) => "name",
                ("trait_item", Owner::Type(_)) => return false,
                _ => {
                    up = n.parent();
                    continue;
                }
            };
            let seg = n
                .child_by_field_name(field)
                .and_then(|f| segment(f, self.src));
            return seg.is_some_and(|s| self.aliases.contains(s));
        }
        false
    }

    /// Whether the path `n` (`a::b::name`) ends in the name through the owner.
    fn path(&self, n: Node<'_>) -> bool {
        let named = n.child_by_field_name("name").map(|i| text_of(i, self.src)) == Some(self.name);
        let Some(path) = n.child_by_field_name("path").filter(|_| named) else {
            return false;
        };
        let seg = if path.kind() == "bracketed_type" {
            // `<T as Tr>::name`: the type reaches a type's item, the trait a trait's.
            path.named_child(0).and_then(|inner| {
                let field = match self.own {
                    Owner::Type(_) => "type",
                    Owner::Trait(_) => "alias",
                };
                let part = if inner.kind() == "qualified_type" {
                    inner.child_by_field_name(field)?
                } else {
                    inner
                };
                segment(part, self.src)
            })
        } else {
            segment(path, self.src)
        };
        self.names_owner(seg, n)
    }

    /// The first token of a macro's `Owner :: name` in the token tree `n`, which the grammar
    /// leaves unparsed.
    fn in_tokens<'t>(&self, n: Node<'t>) -> Option<Node<'t>> {
        let mut c = n.walk();
        let kids: Vec<Node<'t>> = n.children(&mut c).collect();
        kids.windows(3).find_map(|w| {
            let [q, sep, last] = w else { return None };
            let shaped = q.kind() == "identifier" && sep.kind() == "::";
            let named = last.kind() == "identifier" && text_of(*last, self.src) == self.name;
            (shaped && named && self.names_owner(Some(text_of(*q, self.src)), n)).then_some(*q)
        })
    }
}
