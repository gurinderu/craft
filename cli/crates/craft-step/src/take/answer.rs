//! One pending task's answer taken, refused and asked for again, or held.

use std::path::Path;

use serde_json::{Map, Value};

use super::Hold;
use crate::handoff::{self, Aside, HandoffError};
use crate::kind::Kind;
use crate::task::{MAX_RETRIES, Task, TaskState};
use crate::validate;

/// Takes the answer of one pending task, from `given` or the file its agent wrote; one refused is
/// asked for again until its retries are spent — unless `hold` keeps it waiting uncounted: every
/// one on the host's limit, a missing one on a resume (handed out again as first written). Says
/// whether its agent answered at all, valid or not. A refused answer file is marked in `aside`.
///
/// # Errors
/// When the task's id cannot be a file name.
pub fn take_answer<K: Kind>(
    dir: &Path,
    task: &mut Task<K>,
    given: Option<&Map<String, Value>>,
    hold: Hold,
    aside: &mut Aside,
) -> Result<bool, HandoffError> {
    let (submitted, print) = if let Some(g) = given {
        let answer = g.get(&task.id).cloned();
        (
            answer.ok_or_else(|| "no answer was submitted".to_owned()),
            None,
        )
    } else {
        let written = handoff::read_answer(dir, task);
        (written.answer, written.print)
    };
    // The very file whose refusal the state already counts, left in place by a set-aside cut off
    // or failed after the save: moved aside now, its task as the state left it.
    if print.is_some() && print == task.counted {
        aside.mark(dir, task)?;
        return Ok(true);
    }
    // An answer file that cannot be read or parsed was still written: its agent was alive.
    let live = match given {
        Some(g) => g.contains_key(&task.id),
        None => handoff::answer_file(dir, &task.id)?.exists(),
    };
    // An agent that could not do its work fails with its reason at once, before its schema is
    // checked (realm @nick/craft, node #511).
    if let Some(failure) = submitted.as_ref().ok().and_then(|a| K::blocked(task, a)) {
        task.state = TaskState::Failed;
        task.error = Some(failure);
        task.refused = None;
        task.counted = None;
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
            task.counted = None;
            return Ok(true);
        }
        Err(e) => {
            task.error = Some(e);
            // An answer that came back but off its schema is a live vote, not a dead one.
            task.refused = submitted.ok().map(|a| validate::normalize(&a));
        }
    }
    if given.is_none() {
        aside.mark(dir, task)?;
    }
    task.counted = print;
    Ok(refused(task, hold, live))
}

/// A refused answer's task held uncounted (`hold`), or asked for again until its retries are spent;
/// says whether its agent answered at all.
fn refused<K: Kind>(task: &mut Task<K>, hold: Hold, live: bool) -> bool {
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
