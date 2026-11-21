//! Native manifest discovery and legacy external import (realm @nick/craft, #435, #573).
//! Both the compatibility command and `init` use this library; neither operation writes files.

mod argv;
mod candidate;
mod discover;
mod error;
mod files;
mod manifest;
mod memory;
mod pattern;
#[cfg(test)]
mod tests;
mod text;

use craft_store::js::{Js, JsString};
use std::path::Path;

pub use argv::Invocation;
pub use error::Error;

/// Discover integrations under a canonical root, preserving explicit path order and duplicates.
/// `known` is the raw recalled list: import refusals do not remove coverage (#573).
///
/// # Errors
/// When the embedded regex engine cannot run. Per-file refusals are in `unread`.
pub fn discover(root: &Path, paths: Option<&[JsString]>, known: &[Js]) -> Result<Js, Error> {
    discover::discover(&files::canonical(root)?, paths, known)
}

/// Import a list or an `externals`/`records` wrapper, with per-record refusals.
/// Selection and the eight-record limit precede revision reads (#573).
///
/// # Errors
/// When the input has no record list or the embedded engine cannot run.
pub fn import(root: &Path, input: &Js) -> Result<Js, Error> {
    memory::import(
        &files::canonical(root)?,
        record_list(input)
            .ok_or_else(|| Error::refused("stdin is not JSON of a list of records"))?,
    )
}

/// The list itself, or the first array-valued `externals`/`records` property.
#[must_use]
pub fn record_list(input: &Js) -> Option<&[Js]> {
    input.as_arr().or_else(|| {
        let o = input.as_obj()?;
        o.get("externals")
            .and_then(Js::as_arr)
            .or_else(|| o.get("records").and_then(Js::as_arr))
    })
}
