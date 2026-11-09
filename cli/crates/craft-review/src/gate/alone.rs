//! The mechanical gate alone (`craft review gate`): the gate a review start runs, over the whole
//! change, with no run, no lens and no record. rust-audit runs it once for the workspace and its
//! per-crate reviews with `--no-gate` (realm @nick/craft, node #150), so clippy builds the
//! workspace once rather than once per crate side by side on one target directory. Its seeds feed
//! no lens: they are counted on each track, and the gate's own section says so.

use std::path::Path;

use serde_json::{Value, json};

use super::{Gate, GateSetup, Status};
use crate::Error;
use crate::git;
use crate::profile::Profile;
use crate::step::StepError;

/// How the gate came out as a whole: `fail` when a profile's gate is red, else `unknown` when one
/// could not be established, else `pass`; `none` when no profile of the change has a gate.
#[must_use]
pub fn outcome(gate: &Gate) -> &'static str {
    if gate.tracks.is_empty() {
        "none"
    } else if gate.exit().is_some() {
        "fail"
    } else if gate.tracks.iter().any(|t| t.status == Status::Unknown) {
        "unknown"
    } else {
        "pass"
    }
}

/// Runs the gate over the change in `cwd` against `base` (the merge-base with origin's default
/// branch when `None`), the tools' output kept under `dir`, and returns it as one JSON value: the
/// base and head it read, its `outcome`, the red gate's verdict line as a review words it (`''`
/// when not red), the report's gate section, and the gate itself.
///
/// # Errors
/// When the repository or base cannot be read, the profiles cannot be loaded, or `dir` cannot be
/// created.
pub fn alone(
    cwd: &Path,
    base: Option<&str>,
    dir: &Path,
    setup: &GateSetup,
) -> Result<Value, Error> {
    let cwd = cwd.canonicalize().map_err(|source| StepError::NoRepo {
        path: cwd.to_owned(),
        source,
    })?;
    let diff = git::read_diff(&cwd, base, None)?;
    std::fs::create_dir_all(dir).map_err(|source| StepError::NoDir {
        path: dir.to_owned(),
        source,
    })?;
    let profiles = Profile::all()?;
    let (tracks, _) = crate::step::tracks_of(&diff.files, &profiles);
    let (gate, _) = super::run(&cwd, &diff.base, &tracks, setup, dir);
    let line = gate.exit().map(|e| e.line).unwrap_or_default();
    Ok(json!({
        "base": diff.base,
        "head": diff.head,
        "outcome": outcome(&gate),
        "line": line,
        "section": super::section(&gate),
        "gate": gate,
    }))
}
