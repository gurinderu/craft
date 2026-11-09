//! A metrics-or-nothing lens, as the JS adversarial-review engine ran its complexity lens before it was
//! retired (realm @nick/craft, nodes #421, #445): an index warm-up beside the scouts finds whether a code-metrics
//! index covers the repository, and without one the plan drops the lens; each of its findings
//! carries the numbers it rests on, read from the graph — the engine sets no cutoff, and neither does
//! this —, and one carrying none is dropped; its verifier re-reads
//! the metrics rather than judging by argument.

use serde_json::{Value, json};

use crate::agent::Model;
use crate::content::{self, ContentError};
use crate::profile::Profile;
use crate::prompts;
use crate::state::{Task, TaskKind, TaskState};

mod metrics;

pub use metrics::{findings_schema, sift, values};

/// Whether `profile` has a lens that needs the index.
#[must_use]
pub fn wanted(profile: &Profile) -> bool {
    profile.lenses.iter().any(|l| l.metrics)
}

/// The warm-up's task: whether a usable code-metrics index covers the repository at `repo`.
///
/// # Errors
/// When its prompt is missing.
pub fn warmup_task(repo: &str) -> Result<Task, ContentError> {
    Ok(Task::new(
        "index-warmup".into(),
        "index-warmup".into(),
        format!(
            "{}{}",
            prompts::repo_directive(repo),
            content::text("index-warmup")?
        ),
        Model::Sonnet,
        json!({
            "type": "object", "additionalProperties": false, "required": ["indexed", "notes"],
            "properties": {
                "indexed": {"type": "boolean", "description": "true if the codebase-memory index exists and covers the diff base"},
                "notes": {"type": "string"}
            }
        }),
        TaskKind::Warmup,
    ))
}

/// Whether the warm-up among `tasks` found an index, and the note when it did not; `None` when no
/// warm-up was asked.
#[must_use]
pub fn indexed(tasks: &[Task]) -> Option<(bool, Option<String>)> {
    let t = tasks.iter().find(|t| t.kind == TaskKind::Warmup)?;
    let answer = t.answer.as_ref().filter(|_| t.state == TaskState::Answered);
    if answer.and_then(|a| a.get("indexed")) == Some(&Value::Bool(true)) {
        return Some((true, None));
    }
    let why = answer
        .and_then(|a| a.get("notes"))
        .and_then(Value::as_str)
        .map_or("the warm-up died", |n| {
            if n.is_empty() { "no notes" } else { n }
        });
    Some((
        false,
        Some(format!(
            "codebase-memory index unavailable ({}) -> the metrics-or-nothing lenses dropped",
            prompts::sanitize(why)
        )),
    ))
}

/// Whether `f` is a metrics lens's finding: it carries the numbers it rests on.
#[must_use]
pub fn is_metric(f: &Value) -> bool {
    f.get("metrics").is_some_and(Value::is_object)
}

/// The prompt of a metrics lens, `brief` over the diff from `base` as the engine renders it, then
/// what its findings must carry here.
///
/// # Errors
/// When a content file is missing.
pub fn lens_body(brief: &str, base: &str) -> Result<String, ContentError> {
    let body = content::prompt(brief, &content::vars([("base", base.to_owned())]))?;
    Ok(format!("{body}\n\n{}", content::text("lens-metrics")?))
}
