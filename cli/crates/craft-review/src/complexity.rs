//! A metrics-or-nothing lens, as adversarial-review runs its complexity lens (realm @nick/craft,
//! node #421; `dropComplexityUnlessIndexed`, `finderPrompt` and `COMBINED_METRIC_INSTR` in
//! `src/adversarial-review.js`): an index warm-up beside the scouts finds whether a code-metrics
//! index covers the repository, and without one the plan drops the lens; each of its findings
//! carries the numbers it rests on and stands only when one is over its bar; its verifier re-reads
//! the metrics rather than judging by argument.

use serde_json::{Map, Value, json};

use crate::agent::Model;
use crate::content::{self, ContentError};
use crate::profile::Profile;
use crate::prompts;
use crate::state::{Task, TaskKind, TaskState};

/// The bar each metric is held to: a count over its number, or a flag set. Cognitive complexity's
/// is craft's own (realm @nick/craft, node #155); the loop depth and the flags are those the
/// engine's prompt calls High or Medium.
const COUNTS: [(&str, u64); 2] = [("cognitive", 15), ("transitive_loop_depth", 2)];
const FLAGS: [&str; 4] = [
    "linear_scan_in_loop",
    "alloc_in_loop",
    "recursion_in_loop",
    "unguarded_recursion",
];
/// The metrics a finding carries, as the graph names them.
const ALL: [&str; 9] = [
    "cognitive",
    "complexity",
    "loop_depth",
    "transitive_loop_depth",
    "param_count",
    "linear_scan_in_loop",
    "alloc_in_loop",
    "recursion_in_loop",
    "unguarded_recursion",
];

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

/// The findings schema of a metrics lens: each finding also carries `metrics`, the function and
/// the numbers it rests on.
///
/// # Errors
/// When the findings schema is missing.
pub fn findings_schema() -> Result<Value, ContentError> {
    let mut schema = content::schema("findings")?;
    let mut props: Map<String, Value> = ALL
        .iter()
        .map(|m| {
            let ty = if FLAGS.contains(m) {
                "boolean"
            } else {
                "integer"
            };
            ((*m).to_owned(), json!({"type": ty}))
        })
        .collect();
    props.insert("function".into(), json!({"type": "string"}));
    let metrics = json!({"type": "object", "additionalProperties": false, "required": ["function"], "properties": props});
    if let Some(item) = schema.pointer_mut("/properties/findings/items") {
        if let Some(p) = item.get_mut("properties").and_then(Value::as_object_mut) {
            p.insert("metrics".into(), metrics);
        }
        if let Some(r) = item.get_mut("required").and_then(Value::as_array_mut) {
            r.push(json!("metrics"));
        }
    }
    Ok(schema)
}

/// What of `metrics` is over its bar, as `name value (bar)`.
#[must_use]
pub fn over_bar(metrics: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for (m, bar) in COUNTS {
        if let Some(n) = metrics.get(m).and_then(Value::as_u64).filter(|n| *n > bar) {
            out.push(format!("{m} {n} (over {bar})"));
        }
    }
    for m in FLAGS {
        if metrics.get(m) == Some(&Value::Bool(true)) {
            out.push(m.to_owned());
        }
    }
    out
}

/// Whether `f` is a metrics lens's finding: it carries the numbers it rests on.
#[must_use]
pub fn is_metric(f: &Value) -> bool {
    f.get("metrics").is_some_and(Value::is_object)
}

/// Keeps, in each answered task of a metrics lens among `tasks`, only the findings whose numbers
/// are over a bar, each told which; returns the notes on what was dropped.
pub fn sift(tasks: &mut [Task], profiles: &[Profile]) -> Vec<String> {
    let mut notes = Vec::new();
    for t in tasks.iter_mut().filter(|t| t.state == TaskState::Answered) {
        let TaskKind::Lens { profile, lens, .. } = &t.kind else {
            continue;
        };
        let metrics_lens = profiles
            .iter()
            .find(|p| &p.id == profile)
            .and_then(|p| p.lens(lens))
            .is_some_and(|l| l.metrics);
        let found = t
            .answer
            .as_mut()
            .and_then(|a| a.get_mut("findings"))
            .and_then(Value::as_array_mut);
        let (Some(found), true) = (found, metrics_lens) else {
            continue;
        };
        let before = found.len();
        found.retain_mut(|f| {
            let over = over_bar(f.get("metrics").unwrap_or(&Value::Null));
            let why = f
                .get("why")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            if let (false, Some(o)) = (over.is_empty(), f.as_object_mut()) {
                o.insert(
                    "why".into(),
                    json!(format!("{why} [over the bar: {}]", over.join(", "))),
                );
            }
            !over.is_empty()
        });
        if found.len() < before {
            notes.push(format!(
                "{lens}: {} finding(s) dropped — no metric over its bar (cognitive over 15, transitive_loop_depth over 2, or a linear scan, allocation or recursion in a loop, or unguarded recursion)",
                before - found.len()
            ));
        }
    }
    notes
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::over_bar;

    #[test]
    fn a_number_stands_only_over_its_bar() {
        assert!(over_bar(&json!({"cognitive": 15, "transitive_loop_depth": 2, "complexity": 40, "param_count": 12})).is_empty());
        assert_eq!(
            over_bar(
                &json!({"cognitive": 16, "transitive_loop_depth": 3, "alloc_in_loop": true, "linear_scan_in_loop": false})
            ),
            [
                "cognitive 16 (over 15)",
                "transitive_loop_depth 3 (over 2)",
                "alloc_in_loop"
            ]
        );
        assert!(over_bar(&json!(null)).is_empty(), "no numbers, no finding");
    }
}
