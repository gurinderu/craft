//! Where a Rust file sits in the workspace (realm @nick/craft, #564): its package, the crate it is
//! compiled into, its module path in that crate, and what a path's first segment leads to from
//! there — another crate of the workspace, a crate outside it, or this crate's own items.

use std::collections::BTreeSet;

mod files;
mod root;

pub(super) use root::Root;

/// One package of the workspace: its directory (`""` the top), its library's name, whether it has a
/// library target (`src/main.rs` is then a crate of its own) and the crates its manifest depends
/// on, each as code spells it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::consumers) struct Package {
    pub dir: String,
    pub lib: String,
    pub has_lib: bool,
    pub deps: BTreeSet<String>,
}

/// The workspace's packages, or why its manifests could not be read.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(in crate::consumers) struct Workspace {
    packages: Vec<Package>,
    unread: Option<String>,
}

/// One file's place: the crate it is compiled into (a library's name, or the file of another
/// target), its module path there, its package, and whether its workspace is unread (a path is
/// then matched by its owner's last segment alone).
#[derive(Debug, Clone)]
pub(super) struct Unit<'w> {
    pub krate: String,
    pub module: Vec<String>,
    pub degraded: bool,
    package: Option<&'w Package>,
    members: &'w [Package],
}

impl Workspace {
    pub(in crate::consumers) fn of(mut packages: Vec<Package>) -> Self {
        packages.sort_by_key(|p| std::cmp::Reverse(p.dir.len()));
        Self {
            packages,
            unread: None,
        }
    }

    /// A workspace whose manifests could not be read, and why.
    pub(in crate::consumers) fn not_read(why: String) -> Self {
        Self {
            packages: Vec::new(),
            unread: Some(why),
        }
    }

    /// Why the workspace's manifests could not be read, when they could not.
    pub(in crate::consumers) fn unread(&self) -> Option<&str> {
        self.unread.as_deref()
    }

    /// The package whose directory holds `file`, the innermost one.
    fn package_of(&self, file: &str) -> Option<&Package> {
        self.packages.iter().find(|p| {
            p.dir.is_empty()
                || file
                    .strip_prefix(&p.dir)
                    .is_some_and(|r| r.starts_with('/'))
        })
    }

    /// The place of the repository file `file`.
    pub(super) fn unit(&self, file: &str) -> Unit<'_> {
        let package = self.package_of(file);
        let dir = package.map_or("", |p| p.dir.as_str());
        let rel = file
            .strip_prefix(dir)
            .map_or(file, |r| r.trim_start_matches('/'));
        let lib = package.map_or("", |p| p.lib.as_str());
        let has_lib = package.is_some_and(|p| p.has_lib);
        let binary = |inner: &str| inner.starts_with("bin/") || (has_lib && inner == "main.rs");
        let (krate, module) = match rel.strip_prefix("src/") {
            Some(inner) if !binary(inner) => (lib.to_owned(), module_of(inner)),
            _ if package.is_none() => (String::new(), module_of(rel)),
            _ => (file.to_owned(), Vec::new()),
        };
        Unit {
            krate,
            module,
            degraded: self.unread.is_some(),
            package,
            members: &self.packages,
        }
    }
}

/// The module path of a file at `rel` under a crate's source root: `a/b.rs` and `a/b/mod.rs` are
/// `a::b`, `lib.rs` and `main.rs` the root.
fn module_of(rel: &str) -> Vec<String> {
    let stem = rel.strip_suffix(".rs").unwrap_or(rel);
    let mut parts: Vec<String> = stem.split('/').map(str::to_owned).collect();
    if parts.last().is_some_and(|l| l == "mod")
        || matches!(parts.as_slice(), [one] if one == "lib" || one == "main")
    {
        parts.pop();
    }
    parts
}

#[cfg(test)]
#[path = "unit_tests.rs"]
mod tests;
