//! The paths of one file that reach a changed item through its owner, each resolved to the items
//! it can name: a qualifier naming the owner (for a trait, also a type implementing it), `Self`
//! inside an `impl` (or the trait) it is, and for a free function the full path or a bare name
//! called or passed — a `use` declaration itself left out.

use std::collections::BTreeSet;

use tree_sitter::{Node, Tree};

use super::syntax::{in_use, segs, text_of, walk};
use super::{Item, Kind, Owner, Reexports, Resolver, same};

mod inside;
mod tokens;

/// The lines (1-based, ascending) of `text` whose paths reach `name` declared in `own`, each
/// read by `res`, an enclosing module's path reaching it only through a re-export (`rx`).
pub(in crate::consumers::names) fn reaching(
    tree: &Tree,
    text: &str,
    (name, own): (&str, &Owner),
    (res, rx): (&Resolver<'_>, Reexports<'_>),
) -> Vec<u32> {
    let r = Reach {
        src: text,
        name,
        own,
        res,
        rx,
    };
    let mut rows = BTreeSet::new();
    walk(tree.root_node(), |n| {
        let hit = match n.kind() {
            "scoped_identifier" => r.path(n),
            "identifier" => r.bare(n),
            "token_tree" => {
                rows.extend(r.in_tokens(n));
                false
            }
            _ => false,
        };
        if hit {
            rows.insert(n.start_position().row);
        }
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
    res: &'a Resolver<'a>,
    rx: Reexports<'a>,
}

impl Reach<'_> {
    /// Whether the path `segs`, written at `at`, names one of `targets`.
    fn lands<'t>(
        &self,
        segs: &[&str],
        at: Node<'_>,
        mut targets: impl Iterator<Item = &'t Item>,
    ) -> bool {
        let found = self.res.resolve(at, segs);
        targets.any(|t| found.iter().any(|f| same(f, t, self.rx)))
    }

    /// Whether the qualifier `segs` of `…::name`, written at `at`, reaches the item: `Self`
    /// inside its owner, or a path naming the owner (for a free function, the whole path
    /// naming the function).
    fn qualifier(&self, segs: &[&str], at: Node<'_>) -> bool {
        if segs == ["Self"] {
            return self.inside_owner(at);
        }
        if self.own.kind == Kind::Free {
            let mut full = segs.to_vec();
            full.push(self.name);
            return self.lands(&full, at, self.own.targets());
        }
        self.lands(segs, at, self.own.targets())
    }

    /// Whether the type `t` as written at `at` names the owner (`Self` inside it).
    fn type_is_owner(&self, t: Node<'_>, at: Node<'_>) -> bool {
        segs(t, self.src).is_some_and(|s| self.qualifier(&s, at))
    }

    /// Whether the path `n` (`a::b::name`) ends in the name through the owner, outside a `use`.
    fn path(&self, n: Node<'_>) -> bool {
        let named = n.child_by_field_name("name").map(|i| text_of(i, self.src)) == Some(self.name);
        let Some(path) = n
            .child_by_field_name("path")
            .filter(|_| named && !in_use(n))
        else {
            return false;
        };
        if path.kind() == "bracketed_type" {
            return path.named_child(0).is_some_and(|q| self.qualified(q, n));
        }
        self.type_is_owner(path, n)
    }

    /// Whether the bare name `n` is a free function's, called (`name(…)`) or passed (`f(name)`).
    fn bare(&self, n: Node<'_>) -> bool {
        if self.own.kind != Kind::Free || text_of(n, self.src) != self.name {
            return false;
        }
        let called = n.parent().is_some_and(|p| match p.kind() {
            "call_expression" => p.child_by_field_name("function") == Some(n),
            "arguments" => true,
            _ => false,
        });
        called && self.lands(&[self.name], n, self.own.targets())
    }

    /// Whether `<q>::name` reaches the owner: `<T as Tr>` reaches `impl Tr for T`'s item and the
    /// trait `Tr`'s, never an inherent item of `T`; `<T>` reaches `T`'s.
    fn qualified(&self, q: Node<'_>, at: Node<'_>) -> bool {
        let is_type = matches!(self.own.kind, Kind::Type { .. });
        if q.kind() != "qualified_type" {
            return is_type && self.type_is_owner(q, at);
        }
        let part = |f: &str| q.child_by_field_name(f);
        let (Some(ty), Some(tr)) = (part("type"), part("alias")) else {
            return false;
        };
        match &self.own.kind {
            Kind::Type { of_trait: Some(t) } => {
                let last = segs(tr, self.src).and_then(|s| s.last().copied());
                self.type_is_owner(ty, at) && last == Some(t.as_str())
            }
            Kind::Trait { .. } => segs(tr, self.src)
                .is_some_and(|s| self.lands(&s, at, std::iter::once(&self.own.at))),
            Kind::Type { of_trait: None } | Kind::Free => false,
        }
    }
}
