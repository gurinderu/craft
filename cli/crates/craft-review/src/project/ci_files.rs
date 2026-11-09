//! The files a CI map entry's coverage rests on (realm @nick/craft, node #482): its workflow, the
//! recipes, aliases and local actions its command goes through, and each cargo config its jobs'
//! directories read — each hashed when the entry is confirmed, so an edit to any marks it stale.

use std::collections::BTreeMap;
use std::path::{Component, Path};

use sha2::{Digest, Sha256};

use super::ci_configs::cargo_configs;
use super::ci_error::CiError;

/// The SHA-256 of `path` under `top`, hex.
pub(super) fn hash(top: &Path, path: &str) -> Result<String, CiError> {
    let bytes = std::fs::read(top.join(path)).map_err(|error| CiError::Unreadable {
        path: path.to_owned(),
        error,
    })?;
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// The hashes of `files` and of each cargo config `workflow`'s jobs read under `top`, by path.
pub(super) fn hashes(
    top: &Path,
    workflow: &str,
    files: &[&str],
) -> Result<BTreeMap<String, String>, CiError> {
    let configs = cargo_configs(top, workflow);
    let present = configs.iter().filter(|c| top.join(c).is_file());
    files
        .iter()
        .copied()
        .chain(present.map(String::as_str))
        .map(|f| Ok((f.to_owned(), hash(top, f)?)))
        .collect()
}

/// The paths of `hashes` whose file under `top` is no longer the one hashed, and each cargo config
/// `workflow`'s jobs read that appeared since.
pub(super) fn changed(
    top: &Path,
    workflow: &str,
    hashes: &BTreeMap<String, String>,
) -> Vec<String> {
    let moved = hashes
        .iter()
        .filter(|(p, h)| hash(top, p).ok().as_ref() != Some(*h))
        .map(|(p, _)| p.clone());
    let new = cargo_configs(top, workflow)
        .into_iter()
        .filter(|c| !hashes.contains_key(c) && top.join(c).is_file());
    moved.chain(new).collect()
}

/// Refuses a path that is absolute or climbs out of the repository.
pub(super) fn relative(path: &str) -> Result<(), CiError> {
    let inside = !path.is_empty()
        && Path::new(path)
            .components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    inside
        .then_some(())
        .ok_or_else(|| CiError::Outside(path.to_owned()))
}

/// The file a local `uses:` path runs under `top`: a composite action's `action.yml` (or
/// `.yaml`) when the path is its directory, else the path itself.
#[must_use]
pub fn local_file(top: &Path, uses: &str) -> String {
    if !top.join(uses).is_dir() {
        return uses.to_owned();
    }
    let file = ["action.yml", "action.yaml"]
        .into_iter()
        .find(|f| top.join(uses).join(f).is_file())
        .unwrap_or("action.yml");
    format!("{uses}/{file}")
}
