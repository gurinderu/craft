//! `status`: where a run stands, read by the host and, later, by a progress view.

use std::path::Path;

use anyhow::Result;
use serde_json::{Value, json};

use crate::report;
use crate::state::{self, Phase};

/// Where the run in `dir` stands: its phase, counts and every task's state.
///
/// # Errors
/// When the state cannot be read.
pub fn status(dir: &Path) -> Result<Value> {
    let run = state::load(dir)?;
    let [confirmed, suspected, refuted, unverified] = report::tier_counts(&run);
    let tasks: Vec<Value> = run
        .tasks
        .iter()
        .map(|t| {
            json!({"id": t.id, "label": t.label, "state": t.state, "retries": t.retries, "error": t.error})
        })
        .collect();
    let mut s = json!({
        "run": dir.display().to_string(), "phase": run.phase, "done": run.phase == Phase::Done,
        "base": run.diff.base, "mergeBase": run.diff.merge_base,
        "files": run.diff.files.len(), "rustFiles": run.rust_files.len(),
        "findings": run.findings.len(),
        "tiers": {"confirmed": confirmed, "suspected": suspected, "refuted": refuted, "unverified": unverified},
        "tasks": tasks, "notes": run.notes,
    });
    if let (Some(v), Some(obj)) = (&run.verdict, s.as_object_mut()) {
        obj.insert("verdict".into(), json!(v));
        obj.insert(
            "report".into(),
            json!(state::report_path(dir).display().to_string()),
        );
    }
    Ok(s)
}
