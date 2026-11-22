//! An answer file read back, or set aside once refused.

use std::path::Path;

use serde_json::Value;

use super::{HandoffError, answer_file, answers_dir};
use crate::task::Task;

/// The answer the agent of `task` wrote, or why there is none to read, in one line.
///
/// # Errors
/// The file is missing, unreadable, or not JSON.
pub fn read_answer<K>(dir: &Path, task: &Task<K>) -> Result<Value, String> {
    let path = answer_file(dir, &task.id);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!("no answer file was written at {}", path.display()));
        }
        Err(e) => {
            return Err(format!(
                "the answer file {} cannot be read: {e}",
                path.display()
            ));
        }
    };
    serde_json::from_str(&text)
        .map_err(|e| format!("the answer file {} is not JSON: {e}", path.display()))
}

/// Moves a refused answer file aside, so a retry whose agent writes nothing is not read as the
/// same refused answer again.
///
/// # Errors
/// When the file exists and cannot be moved.
pub fn set_aside<K>(dir: &Path, task: &Task<K>) -> Result<(), HandoffError> {
    let from = answer_file(dir, &task.id);
    if !from.exists() {
        return Ok(());
    }
    let to = answers_dir(dir).join(format!("{}.rejected-{}.json", task.id, task.retries));
    std::fs::rename(&from, &to).map_err(|source| HandoffError::Unmovable { path: from, source })
}
