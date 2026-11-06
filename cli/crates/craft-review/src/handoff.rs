//! Tasks and answers travel as files, never through a model's copy (realm @nick/craft, node #453):
//! each pending task's prompt and schema are written under `<run>/tasks/`, its agent writes its
//! answer to `<run>/answers/<id>.json`, and `submit` reads it from there. A task id is its file
//! name, so it is held to a file-safe alphabet.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

use crate::state::{RunState, Task, TaskState};

/// `<run>/tasks`: each pending task's `<id>.md` prompt and `<id>.schema.json` schema.
#[must_use]
pub fn tasks_dir(dir: &Path) -> PathBuf {
    dir.join("tasks")
}

/// `<run>/answers`: each task's `<id>.json` answer, kept once accepted; a refused one is set aside
/// as `<id>.rejected-<n>.json`.
#[must_use]
pub fn answers_dir(dir: &Path) -> PathBuf {
    dir.join("answers")
}

fn prompt_file(dir: &Path, id: &str) -> PathBuf {
    tasks_dir(dir).join(format!("{id}.md"))
}

fn schema_file(dir: &Path, id: &str) -> PathBuf {
    tasks_dir(dir).join(format!("{id}.schema.json"))
}

/// Where the agent of task `id` writes its answer.
#[must_use]
pub fn answer_file(dir: &Path, id: &str) -> PathBuf {
    answers_dir(dir).join(format!("{id}.json"))
}

/// Whether `id` can stand as a file name: ASCII letters, digits, `.`, `_` and `-`, not starting with `.`.
fn file_safe(id: &str) -> bool {
    !id.is_empty()
        && !id.starts_with('.')
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Writes every pending task's prompt (a retry's with why its last answer was refused) and schema,
/// and makes the answers directory.
///
/// # Errors
/// When a task id is not file-safe or a file cannot be written.
pub(crate) fn write_pending(dir: &Path, run: &RunState) -> Result<()> {
    let pending: Vec<&Task> = run
        .tasks
        .iter()
        .filter(|t| t.state == TaskState::Pending)
        .collect();
    if pending.is_empty() {
        return Ok(());
    }
    for d in [tasks_dir(dir), answers_dir(dir)] {
        std::fs::create_dir_all(&d).with_context(|| format!("creating {}", d.display()))?;
    }
    for task in pending {
        if !file_safe(&task.id) {
            bail!("task id {:?} cannot be a file name", task.id);
        }
        let prompt = prompt_file(dir, &task.id);
        std::fs::write(&prompt, task.prompt_text())
            .with_context(|| format!("writing {}", prompt.display()))?;
        let schema = schema_file(dir, &task.id);
        std::fs::write(
            &schema,
            format!("{}\n", serde_json::to_string_pretty(&task.schema)?),
        )
        .with_context(|| format!("writing {}", schema.display()))?;
    }
    Ok(())
}

/// The task as the host receives it: where its prompt and schema are, and where its answer goes.
#[must_use]
pub fn wire(dir: &Path, task: &Task) -> Value {
    let path = |p: PathBuf| p.display().to_string();
    let mut t = json!({
        "id": task.id, "label": task.label, "model": task.model,
        "promptFile": path(prompt_file(dir, &task.id)),
        "schemaFile": path(schema_file(dir, &task.id)),
        "answerFile": path(answer_file(dir, &task.id)),
    });
    if let (Some(a), Some(obj)) = (&task.agent_type, t.as_object_mut()) {
        obj.insert("agentType".into(), json!(a));
    }
    t
}

/// The answer the agent of `task` wrote, or why there is none to read, in one line.
///
/// # Errors
/// The file is missing, unreadable, or not JSON.
pub(crate) fn read_answer(dir: &Path, task: &Task) -> Result<Value, String> {
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
pub(crate) fn set_aside(dir: &Path, task: &Task) -> Result<()> {
    let from = answer_file(dir, &task.id);
    if !from.exists() {
        return Ok(());
    }
    let to = answers_dir(dir).join(format!("{}.rejected-{}.json", task.id, task.retries));
    std::fs::rename(&from, &to).with_context(|| format!("moving {} aside", from.display()))
}

#[cfg(test)]
mod tests {
    use super::file_safe;

    #[test]
    fn ids_are_held_to_file_names() {
        assert!(file_safe("lens-intent") && file_safe("verify-batch-0") && file_safe("a.b_c"));
        for bad in ["", ".", "..", "a/b", "verify:3", "a b", ".hidden"] {
            assert!(!file_safe(bad), "{bad:?}");
        }
    }
}
