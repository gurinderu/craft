//! A step as the host receives it: each pending task's files and what it runs on, the pending
//! step that lists them, and each task's line in a status.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Value, json};

use crate::handoff::{answer_file, prompt_file, schema_file};
use crate::task::Task;

/// The task as the host receives it: where its prompt and schema are, and where its answer goes.
#[must_use]
pub fn wire<K: Serialize>(dir: &Path, task: &Task<K>) -> Value {
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
    // What the task is for (a scout, a lens, a verifier…), by which the host sets its deadline.
    let kind = serde_json::to_value(&task.kind)
        .ok()
        .and_then(|k| k.get("kind").cloned());
    if let (Some(k), Some(obj)) = (kind, t.as_object_mut()) {
        obj.insert("kind".into(), k);
    }
    if let (Some(a), Some(obj)) = (&task.consumer_agent, t.as_object_mut()) {
        obj.insert("consumerAgent".into(), json!(a));
    }
    // A task whose prompt reaches for the code graph's MCP tools, which a lean agent type lacks.
    if let (true, Some(obj)) = (task.graph, t.as_object_mut()) {
        obj.insert("graph".into(), json!(true));
    }
    t
}

/// The step that hands out the pending `tasks` of the run in `dir`: `run`, `tasks` and `done`
/// false, which the kind extends with what its host is to know beside them.
#[must_use]
pub fn pending_step<K: Serialize>(dir: &Path, tasks: &[Task<K>]) -> Value {
    let tasks: Vec<Value> = tasks
        .iter()
        .filter(|t| t.pending())
        .map(|t| wire(dir, t))
        .collect();
    json!({"run": dir.display().to_string(), "tasks": tasks, "done": false})
}

/// A task's line in a run's status: its id, label, state, retries and last refusal.
#[must_use]
pub fn status_line<K>(t: &Task<K>) -> Value {
    json!({"id": t.id, "label": t.label, "state": t.state, "retries": t.retries, "error": t.error})
}
