//! Where a triage run stands, for a host that lost the step that said it.

use std::path::Path;

use serde_json::{Value, json};

use crate::TriageError;
use crate::run::Phase;
use crate::state;

use super::finished::{files, said};

/// Where the run in `dir` stands: its phase and each task's line.
///
/// # Errors
/// When its state cannot be read.
pub fn status(dir: &Path) -> Result<Value, TriageError> {
    let s = state::load(dir)?;
    let tasks: Vec<Value> = s.tasks.iter().map(craft_step::wire::status_line).collect();
    let mut out = json!({"run": dir.display().to_string(), "phase": s.phase, "done": s.phase == Phase::Done, "tasks": tasks});
    said(&mut out, &s);
    if s.phase == Phase::Done {
        files(&mut out, dir);
    }
    Ok(out)
}
