//! Whether a submitted answer is one its task can use: it matches the task's schema, and a batch
//! verdict carries every finding of its batch exactly once. The CONSUMERS lines a lens answer
//! leaves unmarked do not refuse it: they are read beside it and reported as unchecked.

use serde_json::Value;

use crate::state::{Task, TaskKind};

mod consumers;

pub use consumers::{listed, unmarked};

pub use craft_step::validate::normalize;

/// What the review adds to taking an answer: an agent that could not look fails at once, a batch
/// verdict is checked beside the schema, and the CONSUMERS lines an answer left unmarked are kept.
impl craft_step::Kind for TaskKind {
    fn blocked(task: &Task, answer: &Value) -> Option<String> {
        crate::blocked::said(&task.schema, answer).map(|why| crate::blocked::failure(&why))
    }

    fn check(task: &Task, answer: &Value) -> Result<Value, String> {
        check(task, Some(answer))
    }

    fn taken(task: &mut Task, answer: &Value) {
        // Reported as unchecked, never asked for again (realm @nick/craft, node #531).
        task.unmarked = unmarked(answer, &task.consumers);
    }
}

/// The answer `task` can use, or why not, in one line.
///
/// # Errors
/// The refusal: no answer, a schema mismatch, or a batch verdict missing or repeating an index.
pub fn check(task: &Task, answer: Option<&Value>) -> Result<Value, String> {
    let answer = craft_step::validate::check(&task.schema, answer)?;
    if let TaskKind::VerifyBatch { findings } = &task.kind {
        batch_indices(&answer, findings.len())?;
    }
    Ok(answer)
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
