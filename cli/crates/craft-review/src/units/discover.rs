//! The Rust profile's unit discovery, run by the binary itself (the engine's probe agent and its
//! units CLI, `lib/craft-units.mjs`; realm @nick/craft, #362, #377): a unit is a Cargo package —
//! every tracked `Cargo.toml` with a `[package]` table, never a `[workspace]` alone — with its name,
//! its dependencies by the names Cargo matches (`-` taken as `_`, a `package = "…"` rename winning)
//! and the `pub` lines git lists under its directory; and the diff's changed lines by file.

use std::collections::BTreeMap;
use std::path::Path;

use toml::Table;

use super::graph::Package;
use crate::git;

/// git grep's extended pattern for a public line, as the engine's probe greps it.
const PUB_LINE: &str = "^[[:space:]]*pub[[:space:](]";
/// The dependency tables a manifest names its dependencies in.
const DEP_TABLES: [&str; 3] = ["dependencies", "dev-dependencies", "build-dependencies"];

/// Cargo matches a dependency to a package by name with `-` and `_` taken as one character.
fn name_key(name: &str) -> String {
    name.replace('-', "_")
}

/// The dependencies a manifest's tables name, its `target.<cfg>.*` tables included.
fn deps_of(manifest: &Table) -> Vec<String> {
    let in_table = |t: &Table| -> Vec<String> {
        DEP_TABLES
            .iter()
            .filter_map(|k| t.get(*k).and_then(toml::Value::as_table))
            .flat_map(|deps| {
                deps.iter().map(|(k, v)| {
                    let renamed = v.get("package").and_then(toml::Value::as_str);
                    name_key(renamed.unwrap_or(k))
                })
            })
            .collect()
    };
    let targets = manifest.get("target").and_then(toml::Value::as_table);
    let mut out: Vec<String> = in_table(manifest)
        .into_iter()
        .chain(targets.into_iter().flat_map(|t| {
            t.values()
                .filter_map(toml::Value::as_table)
                .flat_map(in_table)
        }))
        .collect();
    out.sort();
    out.dedup();
    out
}

/// The directory of a tracked path, `.` for one at the top.
fn dir_of(path: &str) -> String {
    match path.rsplit_once('/') {
        Some((d, _)) if !d.is_empty() => d.to_owned(),
        _ => ".".into(),
    }
}

/// The public lines git lists under `dir`; none matching is 0, not a failure.
fn sig_lines(top: &Path, dir: &str) -> u64 {
    git::git(top, &["grep", "-h", "-E", PUB_LINE, "--", dir]).map_or(0, |out| {
        u64::try_from(out.lines().count()).unwrap_or(u64::MAX)
    })
}

/// The package a manifest declares, `None` for one with no `[package]` (a workspace root alone) or
/// one that does not parse.
fn package_at(top: &Path, path: &str) -> Option<Package> {
    let text = std::fs::read_to_string(top.join(path)).ok()?;
    let manifest: Table = text.parse().ok()?;
    let package = manifest.get("package")?.as_table()?;
    let name = package
        .get("name")
        .and_then(toml::Value::as_str)
        .unwrap_or("");
    let root = dir_of(path);
    Some(Package {
        sig_lines: sig_lines(top, &root),
        root,
        name: name_key(name),
        deps: deps_of(&manifest),
    })
}

/// The Cargo packages of the repository at `top`, sorted by root.
///
/// # Errors
/// When git cannot list the tracked manifests.
pub fn cargo(top: &Path) -> Result<Vec<Package>, String> {
    let listed =
        git::git(top, &["ls-files", "Cargo.toml", "*/Cargo.toml"]).map_err(|e| e.to_string())?;
    let mut packages: Vec<Package> = listed
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter_map(|f| package_at(top, f))
        .collect();
    packages.sort_by(|a, b| a.root.cmp(&b.root));
    packages.dedup_by(|a, b| a.root == b.root);
    Ok(packages)
}

/// The changed lines (added + deleted) by file of the diff against `base`; a binary file is 0.
///
/// # Errors
/// When git cannot print the numstat.
pub fn numstat(top: &Path, base: &str) -> Result<BTreeMap<String, u64>, String> {
    let out = git::git(
        top,
        &[
            "diff",
            "--numstat",
            "--no-renames",
            "--merge-base",
            base,
            "--",
        ],
    )
    .map_err(|e| e.to_string())?;
    let count = |s: &str| s.parse::<u64>().unwrap_or(0);
    Ok(out
        .lines()
        .filter_map(|l| {
            let mut f = l.splitn(3, '\t');
            let (a, d, path) = (f.next()?, f.next()?, f.next()?);
            Some((path.to_owned(), count(a) + count(d)))
        })
        .collect())
}

#[cfg(test)]
mod tests;
