//! Tasks and answers travel as files, never through a model's copy (realm @nick/craft, node #453),
//! as every kind of run lays them out ([`craft_step::handoff`]): the review renders each pending
//! task's prompt with the skills it names and, when its schema asks, the note on saying it could
//! not look.

use std::path::Path;

pub use craft_step::handoff::{answers_dir, tasks_dir};

use crate::Error;
use crate::blocked;
use crate::state::{RunState, Task};

/// Writes every pending task's prompt (a retry's with why its last answer was refused) and schema,
/// and makes the answers directory.
///
/// # Errors
/// When a task id is not file-safe, a prompt's content is missing, or a file cannot be written.
pub(crate) fn write_pending(dir: &Path, run: &RunState) -> Result<(), Error> {
    craft_step::handoff::write_pending(dir, &run.tasks, |task: &Task| {
        Ok(format!(
            "{}{}{}",
            task.prompt_text(),
            crate::prompts::skills::block(&run.context, &task.prompt),
            blocked::note(&task.schema)?
        ))
    })
}
