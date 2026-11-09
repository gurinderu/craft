//! The cargo configs a CI map entry's command reads (realm @nick/craft, node #482): cargo reads
//! `.cargo/config.toml` (or `.cargo/config`) in the directory it runs in and in each one above it,
//! so a job run under a `working-directory:` reads those on the way from there to the root too.

use std::collections::BTreeSet;
use std::path::{Component, Path};

use super::workflow::unquote;

/// The names cargo reads its config from, in each directory.
const NAMES: [&str; 2] = ["config.toml", "config"];

/// Each `working-directory:` the workflow `text` names — under the workflow's or a job's
/// `defaults: run:`, or a step's — as its directories from the root; one an expression spells
/// (`${{ … }}`) or that leaves the repository is none.
fn working_dirs(text: &str) -> Vec<Vec<String>> {
    text.lines()
        .filter_map(|l| {
            let t = l.trim_start();
            let t = t.strip_prefix("- ").map_or(t, str::trim_start);
            t.strip_prefix("working-directory:")
        })
        .map(|v| unquote(v.split(" #").next().unwrap_or(v).trim()))
        .filter(|v| !v.contains("${{"))
        .filter_map(|v| {
            Path::new(v)
                .components()
                .filter(|c| *c != Component::CurDir)
                .map(|c| match c {
                    Component::Normal(n) => n.to_str().map(str::to_owned),
                    Component::Prefix(_) | Component::RootDir | Component::CurDir => None,
                    Component::ParentDir => None,
                })
                .collect()
        })
        .collect()
}

/// The cargo config paths, repository-relative and existing or not, that a job of `workflow`
/// under `top` may read: the root's and those on each working directory's way up to it. An
/// unreadable workflow gives the root's alone.
pub(super) fn cargo_configs(top: &Path, workflow: &str) -> Vec<String> {
    let text = std::fs::read_to_string(top.join(workflow)).unwrap_or_default();
    let mut dirs = BTreeSet::from([String::new()]);
    for parts in working_dirs(&text) {
        let mut dir = String::new();
        for p in parts {
            dir.push_str(&p);
            dir.push('/');
            dirs.insert(dir.clone());
        }
    }
    dirs.iter()
        .flat_map(|d| NAMES.map(|n| format!("{d}.cargo/{n}")))
        .collect()
}
