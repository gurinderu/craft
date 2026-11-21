//! What a path's first segment leads to from a file: decided per crate, by that crate's own
//! manifest (realm @nick/craft, #564).

use super::Unit;

/// The crates every crate can name without a manifest entry.
const STD: [&str; 5] = ["std", "core", "alloc", "proc_macro", "test"];

/// What a path's first segment leads to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::consumers::names) enum Root {
    /// The workspace crate of this name.
    Crate(String),
    /// A crate outside the workspace (or the 2018 edition's `::` root).
    Out,
    /// An item of this crate, relative to the module the path is written in.
    Here,
}

impl Unit<'_> {
    /// What a path whose first segment is `first` leads to from this file: a workspace crate its
    /// package depends on (or its own library, from another target), a crate outside the
    /// workspace its package depends on, or else this crate's own item.
    pub(in crate::consumers::names) fn root(&self, first: &str) -> Root {
        if first == "::" || STD.contains(&first) {
            return Root::Out;
        }
        let own = self.package.is_some_and(|p| p.lib == first);
        let depends = self.package.is_some_and(|p| p.deps.contains(first));
        let member = self.members.iter().any(|p| p.lib == first);
        if member && first != self.krate && (own || depends) {
            Root::Crate(first.to_owned())
        } else if depends {
            Root::Out
        } else {
            Root::Here
        }
    }
}
