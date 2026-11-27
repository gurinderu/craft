//! Where a triage run stands, for a host that lost the step that said it.

use std::path::Path;

use serde_json::{Value, json};

use crate::TriageError;
use crate::run::Phase;
use crate::state;

use super::finished::{files, gist, plan_path, said};

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
        // The plan's gist, so a host that lost the finished step says what its plan says.
        if let Some(plan) = std::fs::read_to_string(plan_path(dir))
            .ok()
            .and_then(|t| craft_store::js::parse(&t).ok())
        {
            gist(&mut out, &plan)?;
        }
        files(&mut out, dir);
    }
    Ok(out)
}
