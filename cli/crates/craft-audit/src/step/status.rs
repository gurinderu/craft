//! Where an audit run stands, for a host that lost the step that said it.

use std::path::Path;

use serde_json::{Value, json};

use crate::AuditError;
use crate::state::{self, Phase};

use super::{finish, halt};

/// Where the run in `dir` stands: its phase, its pass and each task's line; once a pass ended,
/// what its finished step said.
///
/// # Errors
/// When its state cannot be read.
pub fn status(dir: &Path) -> Result<Value, AuditError> {
    let s = state::load(dir)?;
    let tasks: Vec<Value> = s.tasks.iter().map(craft_step::wire::status_line).collect();
    let mut out = json!({
        "run": dir.display().to_string(),
        "phase": s.phase,
        "pass": s.pass,
        "done": s.phase == Phase::Done,
        "tasks": tasks,
    });
    halt::said(&mut out, &s);
    let finished = std::fs::read_to_string(finish::finished_path(dir))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(|_| s.phase == Phase::Done);
    if let (Some(o), Some(Value::Object(f))) = (out.as_object_mut(), finished) {
        for key in [
            "verdict",
            "report",
            "recordFile",
            "unread",
            "resume",
            "unverifiedLow",
            "filing",
        ] {
            if let Some(v) = f.get(key) {
                o.insert(key.into(), v.clone());
            }
        }
    }
    Ok(out)
}
