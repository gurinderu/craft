//! A step as the host receives it: each pending task's files and what it runs on, the pending
//! step that lists them, and each task's line in a status.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::handoff::{HandoffError, answer_file, prompt_file, schema_file};
use crate::kind::Kind;
use crate::task::Task;

/// The task as the host receives it: where its prompt and schema are, where its answer goes, what
/// it is for (`kind`, by which the host sets its deadline) and what it runs on.
///
/// # Errors
/// When its id cannot be a file name, or its agent cannot be encoded.
pub fn wire<K: Kind>(dir: &Path, task: &Task<K>) -> Result<Value, HandoffError> {
    let path = |p: PathBuf| Value::String(p.display().to_string());
    let mut t = Map::new();
    t.insert("id".into(), json!(task.id));
    t.insert("label".into(), json!(task.label));
    t.insert("model".into(), json!(task.model));
    t.insert("promptFile".into(), path(prompt_file(dir, &task.id)?));
    t.insert("schemaFile".into(), path(schema_file(dir, &task.id)?));
    t.insert("answerFile".into(), path(answer_file(dir, &task.id)?));
    if let Some(a) = &task.agent_type {
        t.insert("agentType".into(), serde_json::to_value(a)?);
    }
    t.insert("kind".into(), json!(task.kind.tag()));
    if let Some(a) = &task.consumer_agent {
        t.insert("consumerAgent".into(), json!(a));
    }
    for (key, value) in K::wire(task) {
        t.insert(key.into(), value);
    }
    Ok(Value::Object(t))
}

/// The step that hands out the pending `tasks` of the run in `dir`: `run`, `tasks` and `done`
/// false, which the kind extends with what its host is to know beside them.
///
/// # Errors
/// As [`wire`].
pub fn pending_step<K: Kind>(dir: &Path, tasks: &[Task<K>]) -> Result<Value, HandoffError> {
    let tasks = tasks
        .iter()
        .filter(|t| t.pending())
        .map(|t| wire(dir, t))
        .collect::<Result<Vec<Value>, _>>()?;
    Ok(json!({"run": dir.display().to_string(), "tasks": tasks, "done": false}))
}

/// A task's line in a run's status: its id, label, state, retries and last refusal.
#[must_use]
pub fn status_line<K: Kind>(t: &Task<K>) -> Value {
    json!({"id": t.id, "label": t.label, "state": t.state, "retries": t.retries, "error": t.error})
}
