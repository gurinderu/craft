//! Whether a submitted answer is one its task can use: it matches the task's schema, and a batch
//! verdict carries every finding of its batch exactly once. The CONSUMERS lines a lens answer
//! leaves unmarked do not refuse it: they are read beside it and reported as unchecked.

use serde_json::Value;

use crate::state::{Task, TaskKind};

mod consumers;

pub use consumers::{listed, unmarked};

pub use craft_step::validate::normalize;

/// The answer `task` can use, or why not, in one line.
///
/// # Errors
/// The refusal: no answer, a schema mismatch, or a batch verdict missing or repeating an index.
pub fn check(task: &Task, answer: Option<&Value>) -> Result<Value, String> {
    let answer = craft_step::validate::check(&task.schema, answer)?;
    if let TaskKind::VerifyBatch { findings } = &task.kind {
        craft_step::validate::batch_indices(&answer, findings.len())?;
    }
    Ok(answer)
}

#[cfg(test)]
mod tests;
