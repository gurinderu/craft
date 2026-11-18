//! Whether a submitted answer is one its task can use: it matches the task's schema, a lens marks
//! every CONSUMERS line it was shown, and a batch verdict carries every finding of its batch
//! exactly once.

use serde_json::Value;

use crate::state::{Task, TaskKind};

mod consumers;

pub use consumers::listed;

/// How many schema errors a refusal names.
const ERRORS_SHOWN: usize = 3;

/// `answer` as JSON: a string that parses as JSON is that JSON (an agent's final text), any other
/// string stays text.
#[must_use]
pub fn normalize(answer: &Value) -> Value {
    match answer {
        Value::String(s) => serde_json::from_str(s.trim()).unwrap_or_else(|_| answer.clone()),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::Array(_) | Value::Object(_) => {
            answer.clone()
        }
    }
}

/// The answer `task` can use, or why not, in one line; on the task's `last` attempt an answer
/// whose only defect is CONSUMERS lines left unmarked is taken, its findings kept and the lines it
/// left returned beside it, to be reported as a coverage gap rather than drop the lens (realm
/// @nick/craft, node #531).
///
/// # Errors
/// The refusal: no answer, a schema mismatch, a CONSUMERS line its prompt listed left unmarked
/// (not on the `last` attempt), or a batch verdict missing or repeating an index.
pub fn check(
    task: &Task,
    answer: Option<&Value>,
    last: bool,
) -> Result<(Value, Vec<String>), String> {
    let answer = normalize(answer.ok_or("no answer was submitted")?);
    let validator = jsonschema::validator_for(&task.schema)
        .map_err(|e| format!("the task's own schema does not compile: {e}"))?;
    let errors: Vec<String> = validator
        .iter_errors(&answer)
        .take(ERRORS_SHOWN)
        .map(|e| {
            let at = e.instance_path().to_string();
            let at = if at.is_empty() { "/".to_owned() } else { at };
            format!("at {at}: {e}")
        })
        .collect();
    if !errors.is_empty() {
        return Err(format!(
            "it does not match the schema ({})",
            errors.join("; ")
        ));
    }
    if let TaskKind::VerifyBatch { findings } = &task.kind {
        batch_indices(&answer, findings.len())?;
    }
    let left = consumers::unmarked(&answer, &task.consumers);
    if !left.is_empty() && !last {
        return Err(consumers::refusal(&left));
    }
    Ok((answer, left))
}

/// Every index `0..count` appears exactly once among the verdicts.
fn batch_indices(answer: &Value, count: usize) -> Result<(), String> {
    let mut seen = vec![false; count];
    let verdicts = answer
        .get("verdicts")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    for v in verdicts {
        let i = v.get("index").and_then(Value::as_u64).unwrap_or(u64::MAX);
        let slot = usize::try_from(i).ok().and_then(|i| seen.get_mut(i));
        match slot {
            Some(s) if !*s => *s = true,
            Some(_) => return Err(format!("verdict index {i} appears twice")),
            None => {
                return Err(format!(
                    "verdict index {i} is not a finding of this batch (0..{count})"
                ));
            }
        }
    }
    match seen.iter().position(|s| !s) {
        Some(i) => Err(format!(
            "no verdict for index {i}: every index 0..{count} must appear"
        )),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests;
