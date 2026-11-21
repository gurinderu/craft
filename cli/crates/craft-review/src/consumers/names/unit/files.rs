//! The files a module of a workspace crate is read from.

use super::Workspace;

impl Workspace {
    /// The files that may hold the module `module` of the crate `krate`.
    pub(in crate::consumers::names) fn files_of(
        &self,
        krate: &str,
        module: &[String],
    ) -> Vec<String> {
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
