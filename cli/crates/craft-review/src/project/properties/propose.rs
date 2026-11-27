//! The `[project]` properties `craft init` offers the reviewer, read from the repository's tracked
//! files with no model (realm @nick/craft, node #654): whether it publishes a library, which rule
//! files it holds, whether it builds controllers. Each comes with what it was read from; nothing is
//! written until the reviewer confirms it.

use std::path::Path;

use serde::Serialize;

/// The rule files a lens is handed, when the repository holds them at its top.
const RULE_FILES: [&str; 3] = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"];

/// The dependencies that make a crate a controller's: the kube-rs client and runtime.
const KUBE_CRATES: [&str; 2] = ["kube", "kube-runtime"];

/// The directory names security lives under, offered as security paths where the tree has them.
const SECURITY_DIRS: [&str; 9] = [
    "auth",
    "crypto",
    "secrets",
    "security",
    "permissions",
    "login",
    "session",
    "token",
    "tokens",
];

/// At most this many security directories are offered: past it the names say too little.
const SECURITY_DIRS_MAX: usize = 8;

/// The Go module that makes a module a controller's.
const CONTROLLER_RUNTIME: &str = "sigs.k8s.io/controller-runtime";

/// One property offered, with the files that gave it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Offer<T> {
    pub value: T,
    pub from: Vec<String>,
}

/// The properties offered; each absent when the files say nothing of it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Offered {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub library: Option<Offer<bool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rules: Option<Offer<Vec<String>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub controllers: Option<Offer<bool>>,
    /// The directories named for security, each a path a write takes as `--security-path`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub security_paths: Vec<String>,
}

/// What the tracked `files` of a repository offer, each read through `read`.
#[must_use]
pub fn offered(files: &[String], read: &dyn Fn(&str) -> Option<String>) -> Offered {
    Offered {
        library: library(files, read),
        rules: rules(files),
        controllers: controllers(files, read),
        security_paths: security_dirs(files),
    }
}

/// What the repository at `top` offers, its tracked files listed by git and read from its tree.
///
/// # Errors
/// When git cannot list the tracked files.
pub fn of_repo(top: &Path) -> Result<Offered, crate::git::GitError> {
    let listed = crate::git::git(top, &["ls-files", "-z"])?;
    let files: Vec<String> = listed
        .split('\0')
        .filter(|f| !f.is_empty())
        .map(str::to_owned)
        .collect();
    Ok(offered(&files, &|f| {
        std::fs::read_to_string(top.join(f)).ok()
    }))
}

fn manifests<'a>(files: &'a [String], name: &'a str) -> impl Iterator<Item = &'a String> {
    files
        .iter()
        .filter(move |f| f.rsplit('/').next() == Some(name) && !crate::paths::is_test_path(f))
}

/// A library when a crate with a library target is not `publish = false`, or a `package.json` is
/// not `private`; no library when manifests are there and none of them is one.
fn library(files: &[String], read: &dyn Fn(&str) -> Option<String>) -> Option<Offer<bool>> {
    let (mut seen, mut published) = (Vec::new(), Vec::new());
    for m in manifests(files, "Cargo.toml") {
        let Some(t) = read(m).and_then(|t| t.parse::<toml::Table>().ok()) else {
            continue;
        };
        let Some(pkg) = t.get("package").and_then(toml::Value::as_table) else {
            continue;
        };
        seen.push(m.clone());
        let dir = m.strip_suffix("Cargo.toml").unwrap_or_default();
        let lib = t.contains_key("lib") || files.iter().any(|f| *f == format!("{dir}src/lib.rs"));
        let private = pkg.get("publish") == Some(&toml::Value::Boolean(false));
        if lib && !private {
            published.push(m.clone());
        }
    }
    for m in manifests(files, "package.json") {
        let Some(v) = read(m).and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        else {
            continue;
        };
        seen.push(m.clone());
        if v.get("private") != Some(&serde_json::Value::Bool(true)) {
            published.push(m.clone());
        }
    }
    if !published.is_empty() {
        return Some(Offer {
            value: true,
            from: published,
        });
    }
    (!seen.is_empty()).then_some(Offer {
        value: false,
        from: seen,
    })
}

/// The rule files the repository holds at its top.
fn rules(files: &[String]) -> Option<Offer<Vec<String>>> {
    let held: Vec<String> = RULE_FILES
        .iter()
        .filter(|r| files.iter().any(|f| f == *r))
        .map(|r| (*r).to_owned())
        .collect();
    (!held.is_empty()).then(|| Offer {
        value: held.clone(),
        from: held,
    })
}

/// Controllers when a crate depends on kube-rs or a Go module on controller-runtime.
fn controllers(files: &[String], read: &dyn Fn(&str) -> Option<String>) -> Option<Offer<bool>> {
    let mut from: Vec<String> = Vec::new();
    for m in manifests(files, "Cargo.toml") {
        let Some(t) = read(m).and_then(|t| t.parse::<toml::Table>().ok()) else {
            continue;
        };
        let deps = ["dependencies", "workspace"].iter().filter_map(|k| {
            let at = t.get(*k)?.as_table()?;
            if *k == "workspace" {
                at.get("dependencies")?.as_table()
            } else {
                Some(at)
            }
        });
        if deps
            .into_iter()
            .any(|d| KUBE_CRATES.iter().any(|k| d.contains_key(*k)))
        {
            from.push(m.clone());
        }
    }
    for m in manifests(files, "go.mod") {
        if read(m).is_some_and(|t| t.contains(CONTROLLER_RUNTIME)) {
            from.push(m.clone());
        }
    }
    (!from.is_empty()).then_some(Offer { value: true, from })
}

/// The directories of tracked non-test files whose name is one security lives under, outermost
/// first; none past [`SECURITY_DIRS_MAX`].
fn security_dirs(files: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for f in files.iter().filter(|f| !crate::paths::is_test_path(f)) {
        let segs: Vec<&str> = f.split('/').collect();
        let Some((_, dirs)) = segs.split_last() else {
            continue;
        };
        let at = dirs
            .iter()
            .position(|d| SECURITY_DIRS.contains(&d.to_lowercase().as_str()));
        if let Some(dir) = at.and_then(|i| dirs.get(..=i)).map(|d| d.join("/"))
            && !out.contains(&dir)
        {
            out.push(dir);
        }
    }
    out.sort();
    if out.len() > SECURITY_DIRS_MAX {
        Vec::new()
    } else {
        out
    }
}

#[cfg(test)]
mod tests;
