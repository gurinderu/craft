//! What a metrics lens's findings carry: the graph's numbers for the function each is about. The
//! engine sets no cutoff in code — its prompt calibrates severity by whether the diff introduced or
//! worsened a metric, and its verifier re-reads them — so none is set here: a finding stands on
//! the metrics it carries, and one that carries none is not a metrics finding at all.

use serde_json::{Map, Value, json};

use crate::content::{self, ContentError};
use crate::profile::Profile;
use crate::state::{Task, TaskKind, TaskState};

/// The metrics a finding carries, as the graph names them: the counts, then the flags.
const COUNTS: [&str; 5] = [
    "cognitive",
    "complexity",
    "loop_depth",
    "transitive_loop_depth",
    "param_count",
];
const FLAGS: [&str; 4] = [
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
    let typed = |names: &[&str], ty: &str| -> Vec<(String, Value)> {
        names
            .iter()
            .map(|m| ((*m).to_owned(), json!({"type": ty})))
            .collect()
    };
    let mut props: Map<String, Value> = typed(&COUNTS, "integer").into_iter().collect();
    props.extend(typed(&FLAGS, "boolean"));
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

/// The values `metrics` carries, as `name value`, in the graph's order.
#[must_use]
pub fn values(metrics: &Value) -> Vec<String> {
    COUNTS
        .iter()
        .chain(&FLAGS)
        .filter_map(|m| Some(format!("{m} {}", metrics.get(*m)?)))
        .collect()
}

/// Keeps `f` when it carries a metric value, stating them in its `why` for its verifier.
fn carries(f: &mut Value) -> bool {
    let read = values(f.get("metrics").unwrap_or(&Value::Null));
    let why = f
        .get("why")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    if let (false, Some(o)) = (read.is_empty(), f.as_object_mut()) {
        let why = format!("{why} [metrics: {}]", read.join(", "));
        o.insert("why".into(), json!(why));
    }
    !read.is_empty()
}

/// Keeps, in each answered task of a metrics lens among `tasks`, only the findings that carry a
/// metric value, each stating them; returns the notes on what was dropped.
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
        found.retain_mut(carries);
        if found.len() < before {
            notes.push(format!(
                "{lens}: {} finding(s) dropped — they carry no metric value read from the graph (metrics-or-nothing)",
                before - found.len()
            ));
        }
    }
    notes
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::values;

    #[test]
    fn a_finding_stands_on_the_values_it_carries_whatever_they_are() {
        assert_eq!(
            values(&json!({"function": "f", "alloc_in_loop": false, "cognitive": 3})),
            ["cognitive 3", "alloc_in_loop false"]
        );
        assert!(
            values(&json!({"function": "f"})).is_empty(),
            "no numbers, no finding"
        );
        assert!(values(&json!(null)).is_empty());
    }
}
