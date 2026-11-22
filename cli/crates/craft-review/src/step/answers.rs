//! The review's move after a submit's answers are taken ([`craft_step::take`]): the run moved on or
//! held.

use std::path::Path;

use super::Said;
use crate::Error;
use crate::phases::advance;
use crate::state::{Phase, RunState, TaskState};
use crate::stop;

/// Moves the run on once this submit's answers are in: stopped on the host's limit (after
/// advancing when nothing is left to wait for) or on a round that died whole — never read from a
/// resume, whose missing answers are held — else advanced.
pub(super) fn move_on(dir: &Path, run: &mut RunState, said: &Said<'_>) -> Result<(), Error> {
    if let Some(text) = said.limit {
        if run.tasks.iter().all(|t| t.state != TaskState::Pending) {
            advance(dir, run)?;
        }
        if run.phase != Phase::Done {
            stop::hold(run, stop::limit(text));
        }
        return Ok(());
    }
    match stop::round_died(run).filter(|_| !said.resume) {
        Some(why) => stop::hold(run, stop::deaths(why)),
        None => advance(dir, run)?,
    }
    Ok(())
}
