//! The answer a task kept when it was refused only for the CONSUMERS lines it left unmarked (realm
//! @nick/craft, node #531). It lives beside the answers as `<id>.marks-only.json`, written whole
//! before the refused answer file is set aside, so a stop at any moment leaves it; every path that
//! would end the task failed goes through [`fail`], which takes it instead; an accepted attempt
//! drops it.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::handoff::{self, HandoffError};
use crate::state::{Task, TaskState};

fn file(dir: &Path, id: &str) -> PathBuf {
    handoff::answers_dir(dir).join(format!("{id}.marks-only.json"))
}

/// Keeps `answer`, the latest of `task` refused only for its unmarked lines, whole or not at all.
///
/// # Errors
/// When the file cannot be written.
pub(crate) fn keep(dir: &Path, task: &Task, answer: &Value) -> Result<(), HandoffError> {
    let d = handoff::answers_dir(dir);
    std::fs::create_dir_all(&d).map_err(|source| HandoffError::NoDir { path: d, source })?;
    let path = file(dir, &task.id);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string(answer)?).map_err(|source| {
        HandoffError::Unwritable {
            path: tmp.clone(),
            source,
        }
    })?;
    std::fs::rename(&tmp, &path).map_err(|source| HandoffError::Unwritable { path, source })
}

/// Drops what `task` kept: a later attempt was accepted.
///
/// # Errors
/// When the file is there and cannot be removed.
pub(crate) fn clear(dir: &Path, task: &Task) -> Result<(), HandoffError> {
    let path = file(dir, &task.id);
    match std::fs::remove_file(&path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            Err(HandoffError::Unwritable { path, source: e })
        }
        _ => Ok(()),
    }
}

/// Ends `task` failed with `why` — unless it kept an answer refused only for unmarked lines: then it
/// takes that answer, those lines reported. A kept answer that cannot be read is named in `why`.
pub(crate) fn fail(dir: &Path, task: &mut Task, why: String) {
    match taken(dir, task) {
        Ok(Some((answer, unmarked))) => {
            task.answer = Some(answer);
            task.unmarked = unmarked;
            task.state = TaskState::Answered;
            task.error = None;
            task.refused = None;
        }
        Ok(None) => {
            task.state = TaskState::Failed;
            task.error = Some(why);
        }
        Err(e) => {
            task.state = TaskState::Failed;
            task.error = Some(format!("{why}; the answer it kept could not be read: {e}"));
        }
    }
}

/// The answer `task` kept and the lines it left unmarked; `None` when it kept none.
fn taken(dir: &Path, task: &Task) -> Result<Option<(Value, Vec<String>)>, String> {
    let path = file(dir, &task.id);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let kept: Value =
        serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    crate::validate::check(task, Some(&kept), true).map(Some)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{fail, file};
    use crate::state::{Task, TaskKind, TaskState};

    #[test]
    fn a_kept_answer_that_cannot_be_read_fails_the_task_and_says_so() {
        let t = tempfile::tempdir().unwrap();
        let mut task = Task::new(
            "lens-rust-errors-r1".into(),
            "l".into(),
            "p".into(),
            crate::agent::Model::Opus,
            json!({}),
            TaskKind::Seam {
                profile: "rust".into(),
            },
        );
        std::fs::create_dir_all(crate::handoff::answers_dir(t.path())).unwrap();
        std::fs::write(file(t.path(), &task.id), "{ not json").unwrap();
        fail(t.path(), &mut task, "retries spent".into());
        assert_eq!(task.state, TaskState::Failed);
        let error = task.error.unwrap_or_default();
        assert!(
            error.starts_with("retries spent; the answer it kept could not be read: "),
            "{error}"
        );
    }
}
