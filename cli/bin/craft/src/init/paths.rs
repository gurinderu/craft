//! `craft init --propose --path`: the manifests the reviewer names, read in place of the walk and
//! in the order given, duplicates kept (realm @nick/craft, node #435) — the way to reach a manifest
//! past the walk's bound.

use std::path::{Component, Path};

use anyhow::{Result, bail};
use craft_store::js::JsString;

/// At most this many named manifests, as the discovery's explicit list always took.
const MAX: usize = 24;

/// `given` as paths relative to the repository's `top`, or `None` when none was named. A path is
/// relative to `top` or absolute inside it; empty, `..` or one outside the repository is refused.
pub(super) fn named(top: &Path, given: &[String]) -> Result<Option<Vec<JsString>>> {
    if given.is_empty() {
        return Ok(None);
    }
    if given.len() > MAX {
        bail!("--path is given {} times: at most {MAX}", given.len());
    }
    let canonical = top.canonicalize().ok();
    given
        .iter()
        .map(|p| relative(top, canonical.as_deref(), p))
        .collect::<Result<Vec<_>>>()
        .map(Some)
}

fn relative(top: &Path, canonical: Option<&Path>, given: &str) -> Result<JsString> {
    let path = Path::new(given);
    let rel = if path.is_absolute() {
        [Some(top), canonical]
            .into_iter()
            .flatten()
            .find_map(|t| path.strip_prefix(t).ok())
            .ok_or_else(|| outside(given))?
    } else {
        path
    };
    if rel.as_os_str().is_empty()
        || rel
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(outside(given));
    }
    Ok(JsString::from(rel.to_string_lossy().into_owned()))
}

fn outside(given: &str) -> anyhow::Error {
    anyhow::anyhow!(
        "--path {given}: not a file inside the repository (a path relative to its top, or absolute inside it, with no `..`)"
    )
}
