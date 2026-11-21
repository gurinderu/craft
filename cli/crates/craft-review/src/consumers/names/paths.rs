//! The structural search's reading of one Rust file (realm @nick/craft, nodes #529, #564): what a
//! changed item is declared in, and the lines whose paths reach it — `T::name`, `Self::name`
//! inside an `impl` of `T`, `<T as Tr>::name`, `Tr::name` or `X::name` (`impl Tr for X`) for a
//! trait's item, `m::name` and a bare `name` called or passed for a free function — each path
//! resolved to the full one it names from the file's module, its `use` declarations (an alias,
//! `{self as x}`, a glob) and the crates its own manifest depends on, read from the tree-sitter
//! syntax tree, so comments, strings and items of the name in another module or crate never
//! match. A call through a value (`x.name()`) carries no type and is not read.

mod syntax;

mod declared;
mod imports;
mod owner;
mod reach;
mod resolve;

pub(super) use syntax::parse;

pub(super) use imports::reexports;
pub(super) use owner::{implementors, owner};
pub(super) use reach::reaching;
pub(super) use resolve::Resolver;

/// An item by its full path: the crate it is in (a library's name, or another target's file) and
/// its module path, its own name last.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct Item {
    pub krate: String,
    pub path: Vec<String>,
}

/// Whether a re-export brings the name (the `&str`) into the module (the [`Item`]): a path through
/// an enclosing module of an item's own reaches it only so.
pub(super) type Reexports<'a> = &'a dyn Fn(&Item, &str) -> bool;

/// What a changed function is declared in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Kind {
    /// `impl T` (`of_trait` none) or `impl Tr for T` (`of_trait` the trait's last segment);
    /// `also` the other types `T` can be, when more than one glob can bring it in.
    Type {
        of_trait: Option<String>,
        also: Vec<Item>,
    },
    /// `trait Tr`, with the types found implementing it.
    Trait { impls: Vec<Item> },
    /// A module: a free function.
    Free,
}

/// A changed function's owner: its kind, and `at` — the type or the trait, or for a free
/// function the function itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Owner {
    pub kind: Kind,
    pub at: Item,
}

impl Owner {
    /// The names a file reaching the item through its owner names besides the item's own: the
    /// type, the trait and its implementors; none for a free function.
    pub(super) fn words(&self) -> Vec<&str> {
        let own = self.at.path.last().map(String::as_str);
        match &self.kind {
            Kind::Free => Vec::new(),
            Kind::Type { also: more, .. } | Kind::Trait { impls: more } => own
                .into_iter()
                .chain(
                    more.iter()
                        .filter_map(|i| i.path.last().map(String::as_str)),
                )
                .collect(),
        }
    }

    /// The items a qualifier (the full path, for a free function) must name to reach the item.
    pub(super) fn targets(&self) -> impl Iterator<Item = &Item> {
        let more = match &self.kind {
            Kind::Trait { impls: more } | Kind::Type { also: more, .. } => more.as_slice(),
            Kind::Free => &[],
        };
        std::iter::once(&self.at).chain(more)
    }
}

/// Whether `found` is `target`: the same path, or a shorter one through an enclosing module of
/// `target`'s own that re-exports its name (`rx`).
pub(super) fn same(found: &Item, target: &Item, rx: Reexports<'_>) -> bool {
    if found == target {
        return true;
    }
    let (Some((last, module)), Some((t_last, t_module))) =
        (found.path.split_last(), target.path.split_last())
    else {
        return false;
    };
    let enclosing = module.len() < t_module.len() && t_module.starts_with(module);
    let through = Item {
        krate: found.krate.clone(),
        path: module.to_vec(),
    };
    found.krate == target.krate && last == t_last && enclosing && rx(&through, last)
}

#[cfg(test)]
#[path = "paths_owner_tests.rs"]
mod owner_tests;
#[cfg(test)]
#[path = "paths_tests.rs"]
mod tests;
