//! Where a Rust file sits in the workspace (realm @nick/craft, #564): its package, the crate it is
//! compiled into, its module path in that crate, and what a path's first segment leads to from
//! there — another crate of the workspace, a crate outside it, or this crate's own items.

use std::collections::BTreeSet;

mod root;

pub(super) use root::Root;

/// One package of the workspace: its directory (`""` the top), its library's name and the crates
/// its manifest depends on, each as code spells it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::consumers) struct Package {
    pub dir: String,
    pub lib: String,
    pub deps: BTreeSet<String>,
}

/// The workspace's packages.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(in crate::consumers) struct Workspace {
    packages: Vec<Package>,
}

/// One file's place: the crate it is compiled into (a library's name, or the file of another
/// target), its module path there, and its package.
#[derive(Debug, Clone)]
pub(super) struct Unit<'w> {
    pub krate: String,
    pub module: Vec<String>,
    package: Option<&'w Package>,
    members: &'w [Package],
}

impl Workspace {
    pub(in crate::consumers) fn of(mut packages: Vec<Package>) -> Self {
        packages.sort_by_key(|p| std::cmp::Reverse(p.dir.len()));
        Self { packages }
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
        let (krate, module) = match rel.strip_prefix("src/") {
            Some(inner) if !inner.starts_with("bin/") => (lib.to_owned(), module_of(inner)),
            _ if package.is_none() => (String::new(), module_of(rel)),
            _ => (file.to_owned(), Vec::new()),
        };
        Unit {
            krate,
            module,
            package,
            members: &self.packages,
        }
    }

    /// The files that may hold the module `module` of the crate `krate`.
    pub(super) fn files_of(&self, krate: &str, module: &[String]) -> Vec<String> {
        let Some(p) = self.packages.iter().find(|p| p.lib == krate) else {
            return if krate.contains('/') && module.is_empty() {
                vec![krate.to_owned()]
            } else if krate.is_empty() {
                stems(&["src"], module)
            } else {
                Vec::new()
            };
        };
        let src = if p.dir.is_empty() {
            "src".to_owned()
        } else {
            format!("{}/src", p.dir)
        };
        stems(&[src.as_str()], module)
    }
}

/// The files a module path is read from under each of `dirs`.
fn stems(dirs: &[&str], module: &[String]) -> Vec<String> {
    let join = |d: &str, rest: &str| {
        if d.is_empty() {
            rest.to_owned()
        } else {
            format!("{d}/{rest}")
        }
    };
    let mut out = Vec::new();
    for d in dirs {
        if module.is_empty() {
            out.extend(["lib.rs", "main.rs"].map(|f| join(d, f)));
        } else {
            let m = module.join("/");
            out.extend([format!("{m}.rs"), format!("{m}/mod.rs")].map(|f| join(d, &f)));
        }
    }
    out
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
