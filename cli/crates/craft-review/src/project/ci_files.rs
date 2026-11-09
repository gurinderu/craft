//! The files a CI map entry's coverage rests on (realm @nick/craft, node #482): its workflow, the
//! recipes, aliases and local actions its command goes through, and the cargo config when there
//! is one — each hashed when the entry is confirmed, so an edit to any marks it stale.

use std::collections::BTreeMap;
use std::path::{Component, Path};

use sha2::{Digest, Sha256};

use super::ci_error::CiError;
use super::workflow::jobs;

/// Cargo's config files, which alias commands: always among an entry's files when one exists.
pub(super) const CARGO_CONFIGS: [&str; 2] = [".cargo/config.toml", ".cargo/config"];

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

/// The hashes of `files` and of each cargo config under `top`, by path.
pub(super) fn hashes(top: &Path, files: &[&str]) -> Result<BTreeMap<String, String>, CiError> {
    let configs = CARGO_CONFIGS.into_iter().filter(|c| top.join(c).is_file());
    files
        .iter()
        .copied()
        .chain(configs)
        .map(|f| Ok((f.to_owned(), hash(top, f)?)))
        .collect()
}

/// The paths of `hashes` whose file under `top` is no longer the one hashed, and each cargo config
/// that appeared since.
pub(super) fn changed(top: &Path, hashes: &BTreeMap<String, String>) -> Vec<String> {
    let moved = hashes
        .iter()
        .filter(|(p, h)| hash(top, p).ok().as_ref() != Some(*h))
        .map(|(p, _)| p.clone());
    let new = CARGO_CONFIGS
        .into_iter()
        .filter(|c| !hashes.contains_key(*c) && top.join(c).is_file())
        .map(str::to_owned);
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

/// Refuses an entry whose workflow, read under `top`, runs a local `uses: ./…` (a composite action,
/// a reusable workflow) that none of `sources` is or lies under. The jobs `check` names are read,
/// every job when none is named so.
pub(super) fn local_uses_listed(
    top: &Path,
    workflow: &str,
    check: &str,
    sources: &[String],
) -> Result<(), CiError> {
    let text =
        std::fs::read_to_string(top.join(workflow)).map_err(|error| CiError::Unreadable {
            path: workflow.to_owned(),
            error,
        })?;
    let all = jobs(&text);
    let named = |j: &&super::workflow::Job| {
        let n = j.name.as_deref().unwrap_or(&j.id);
        n == check || check.strip_prefix(n).is_some_and(|r| r.starts_with(" ("))
    };
    let mine: Vec<_> = all.iter().filter(named).collect();
    let read = if mine.is_empty() {
        all.iter().collect()
    } else {
        mine
    };
    let listed = |u: &str| {
        sources
            .iter()
            .any(|s| s == u || s.starts_with(&format!("{u}/")))
    };
    match read.iter().flat_map(|j| &j.uses).find(|u| !listed(u)) {
        Some(u) => Err(CiError::LocalUses {
            check: check.to_owned(),
            uses: u.clone(),
        }),
        None => Ok(()),
    }
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
