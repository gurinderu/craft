//! The findings no verifier checked at Low or Info severity, held apart from the report a session
//! reads whole (realm @nick/craft, node #636): written to `unverified.md` beside the report, the
//! report and the finished step naming how many there are and where. An unverified finding at
//! Medium or above is still listed: its check died, it was not skipped.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::settle::Tier;
use crate::state::RunState;
use crate::step::StepError;

/// The file the held findings are written to, in the run directory.
pub const FILE: &str = "unverified.md";

/// Where the run in `dir` keeps its held findings.
#[must_use]
pub fn path(dir: &Path) -> PathBuf {
    dir.join(FILE)
}

/// Whether `f` is held apart: unverified, at Low or Info severity.
#[must_use]
pub fn held(f: &Value) -> bool {
    Tier::of(f) == Tier::Unverified
        && matches!(
            f.get("severity").and_then(Value::as_str),
            Some("Low" | "Info")
        )
}

/// The run's held findings, most severe first.
fn of(state: &RunState) -> Vec<&Value> {
    let mut list: Vec<&Value> = state.settled.iter().filter(|f| held(f)).collect();
    list.sort_by_key(|f| crate::dedup::sev_rank(f));
    list
}

/// The report's line on the held findings, "" when there are none.
pub(super) fn line(state: &RunState) -> String {
    match of(state).len() {
        0 => String::new(),
        n => format!(
            "{n} Low or Info finding(s) no verifier checked are not listed here: they are in `{FILE}` beside this report.\n"
        ),
    }
}

/// What the finished step says of them: their count and file, `None` when there are none.
#[must_use]
pub fn step_field(dir: &Path, state: &RunState) -> Option<Value> {
    let n = of(state).len();
    (n > 0).then(|| json!({"count": n, "file": path(dir).display().to_string()}))
}

/// Writes the held findings beside the report, or removes a file an earlier write left when there
/// are none now.
///
/// # Errors
/// When the file cannot be written.
pub(super) fn write(dir: &Path, state: &RunState) -> Result<(), StepError> {
    let path = path(dir);
    let list = of(state);
    if list.is_empty() {
        drop(std::fs::remove_file(&path));
        return Ok(());
    }
    let mut out = String::from(
        "# Unverified Low and Info findings\n\nNo verifier checked these against the code.\n\n",
    );
    for f in list {
        out.push_str(&super::entry(f));
    }
    std::fs::write(&path, out).map_err(|source| StepError::NoReport { path, source })
}
