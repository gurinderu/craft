//! What a metrics lens's findings carry and what they stand on: the graph's numbers for the
//! function each is about, and at least one of them over its bar.

use serde_json::{Map, Value, json};

use crate::content::{self, ContentError};
use crate::profile::Profile;
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

/// What of `metrics` is over its bar, as `name value (over bar)`.
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

/// Keeps `f` when a number of it is over its bar, telling it which in its `why`.
fn stands(f: &mut Value) -> bool {
    let over = over_bar(f.get("metrics").unwrap_or(&Value::Null));
    let why = f
        .get("why")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    if let (false, Some(o)) = (over.is_empty(), f.as_object_mut()) {
        let why = format!("{why} [over the bar: {}]", over.join(", "));
        o.insert("why".into(), json!(why));
    }
    !over.is_empty()
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
        found.retain_mut(stands);
        if found.len() < before {
            notes.push(format!(
                "{lens}: {} finding(s) dropped — no metric over its bar (cognitive over 15, transitive_loop_depth over 2, or a linear scan, allocation or recursion in a loop, or unguarded recursion)",
                before - found.len()
            ));
        }
    }
    notes
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
