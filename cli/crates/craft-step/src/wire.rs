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
/// When its id cannot be a file name, its agent cannot be encoded, or the kind's own fields name
/// one every task carries ([`HandoffError::WireClash`]).
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
        if t.insert(key.into(), value).is_some() {
            return Err(HandoffError::WireClash(key));
        }
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

#[cfg(test)]
mod tests {
    use serde::{Deserialize, Serialize};
    use serde_json::{Value, json};

    use super::wire;
    use crate::handoff::HandoffError;
    use crate::{Kind, Model, Task};

    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    struct Empty {}

    /// A kind whose own wire fields are `fields`, by its tag.
    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    #[serde(tag = "kind")]
    enum Own {
        #[serde(rename = "clash")]
        Clash,
        #[serde(rename = "apart")]
        Apart,
    }

    impl Kind for Own {
        type Agent = String;
        type Marks = Empty;
        type Flags = Empty;

        fn tag(&self) -> &'static str {
            match self {
                Self::Clash => "clash",
                Self::Apart => "apart",
            }
        }

        fn wire(task: &Task<Self>) -> Vec<(&'static str, Value)> {
            match task.kind {
                Self::Clash => vec![("answerFile", json!("/elsewhere.json"))],
                Self::Apart => vec![("lens", json!("errors"))],
            }
        }
    }

    fn task(kind: Own) -> Task<Own> {
        Task::new(
            "t".into(),
            "t".into(),
            "p".into(),
            Model::Haiku,
            json!({}),
            kind,
        )
    }

    #[test]
    fn a_kind_field_never_replaces_a_shared_one() {
        let dir = std::path::Path::new("/run");
        let got = wire(dir, &task(Own::Clash));
        assert!(
            matches!(got, Err(HandoffError::WireClash("answerFile"))),
            "{got:?}"
        );
        let apart = wire(dir, &task(Own::Apart)).unwrap();
        assert_eq!(
            (apart["lens"].clone(), apart["answerFile"].clone()),
            (json!("errors"), json!("/run/answers/t.json"))
        );
    }
}
