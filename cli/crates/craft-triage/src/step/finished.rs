//! The finished run as the host receives it: the plan and the record, each written beside the
//! state with its keys in the engine's order, and the step naming them.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::TriageError;
use crate::run::Finished;

/// Where the finished run's plan is written.
#[must_use]
pub fn plan_path(dir: &Path) -> PathBuf {
    dir.join("plan.json")
}

/// Where the finished run's record is written.
#[must_use]
pub fn record_path(dir: &Path) -> PathBuf {
    dir.join("record.json")
}

/// Writes the plan and the record of `done` into `dir`.
///
/// # Errors
/// When a file cannot be written.
pub(super) fn write(dir: &Path, done: &Finished) -> Result<(), TriageError> {
    for (path, v) in [
        (plan_path(dir), &done.plan),
        (record_path(dir), &done.record),
    ] {
        std::fs::write(&path, format!("{}\n", v.pretty()))
            .map_err(|source| TriageError::Unwritable { path, source })?;
    }
    Ok(())
}

/// The finished step: the plan (its file holds its keys in the engine's order) and where it and
/// the record are.
pub(super) fn step(dir: &Path, done: &Finished) -> Value {
    json!({
        "run": dir.display().to_string(),
        "done": true,
        "plan": Value::try_from(&done.plan).unwrap_or(Value::Null),
        "planFile": plan_path(dir).display().to_string(),
        "recordFile": record_path(dir).display().to_string(),
    })
}
