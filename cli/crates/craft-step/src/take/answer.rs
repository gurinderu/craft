//! One pending task's answer taken, refused and asked for again, or held.

use std::path::Path;

use serde_json::{Map, Value};

use super::{Hold, Kind};
use crate::handoff::{self, HandoffError};
use crate::task::{MAX_RETRIES, Task, TaskState};
use crate::validate;

/// Takes the answer of one pending task, from `given` or the file its agent wrote; one refused is
/// asked for again until its retries are spent — unless `hold` keeps it waiting uncounted: every
/// one on the host's limit, a missing one on a resume (handed out again as first written). Says
/// whether its agent answered at all, valid or not.
///
/// # Errors
/// When a refused answer file cannot be moved aside.
pub fn take_answer<K: Kind>(
    dir: &Path,
    task: &mut Task<K>,
    given: Option<&Map<String, Value>>,
    hold: Hold,
) -> Result<bool, HandoffError> {
    let submitted = match given {
        Some(g) => g
            .get(&task.id)
            .cloned()
            .ok_or_else(|| "no answer was submitted".to_owned()),
        None => handoff::read_answer(dir, task),
    };
    // An answer file that cannot be read or parsed was still written: its agent was alive.
    let live = match given {
        Some(g) => g.contains_key(&task.id),
        None => handoff::answer_file(dir, &task.id).exists(),
    };
    // An agent that could not do its work fails with its reason at once, before its schema is
    // checked (realm @nick/craft, node #511).
    if let Some(failure) = submitted.as_ref().ok().and_then(|a| K::blocked(task, a)) {
        task.state = TaskState::Failed;
        task.error = Some(failure);
        task.refused = None;
        return Ok(true);
    }
    let checked = submitted
        .as_ref()
        .map_err(Clone::clone)
        .and_then(|a| K::check(task, a));
    match checked {
        Ok(answer) => {
            K::taken(task, &answer);
            task.answer = Some(answer);
            task.state = TaskState::Answered;
            task.error = None;
            task.refused = None;
            return Ok(true);
        }
        Err(e) => {
            task.error = Some(e);
            // An answer that came back but off its schema is a live vote, not a dead one.
            task.refused = submitted.ok().map(|a| validate::normalize(&a));
        }
    }
    if given.is_none() {
        handoff::set_aside(dir, task)?;
    }
    Ok(refused(task, hold, live))
}

/// A refused answer's task held uncounted (`hold`), or asked for again until its retries are spent;
/// says whether its agent answered at all.
fn refused<K>(task: &mut Task<K>, hold: Hold, live: bool) -> bool {
    match hold {
        Hold::Every => return live,
        Hold::Missing if !live => {
            // Handed out again as first written, its ladder whole, as a stop holds a task.
            task.retries = 0;
            task.error = None;
            task.refused = None;
            return false;
        }
        Hold::Missing | Hold::Nothing => {}
    }
    if task.retries < MAX_RETRIES {
        task.retries += 1;
    } else {
        task.state = TaskState::Failed;
    }
    live
}
