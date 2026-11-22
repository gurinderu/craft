//! One pending task's answer taken, refused and asked for again, or held.

use std::path::Path;

use serde_json::{Map, Value};

use super::Hold;
use crate::handoff::{self, Aside, HandoffError};
use crate::kind::Kind;
use crate::task::{Counted, MAX_RETRIES, Task, TaskState};
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
    // or failed after the save: moved aside now, its task as the state left it, its agent not
    // read as alive; found there yet again, no new answer came, and it counts as a missing one.
    match recount(task, print.as_deref()) {
        Recount::New => {}
        Recount::Again(at) => {
            aside.mark_at(dir, task, at)?;
            return Ok(false);
        }
        Recount::Missing(at) => {
            aside.mark_at(dir, task, at)?;
            let path = handoff::answer_file(dir, &task.id)?;
            task.error = Some(format!(
                "no new answer was written: {} still holds the answer refused before, which could not be set aside",
                path.display()
            ));
            task.refused = None;
            // Not one of a resume's agents never run: the file is there, so it is counted.
            let hold = if hold == Hold::Missing {
                Hold::Nothing
            } else {
                hold
            };
            return Ok(refused(task, hold, false));
        }
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
        task.counted = print.map(|print| Counted {
            print,
            at: task.retries,
            again: false,
        });
    }
    Ok(refused(task, hold, live))
}

/// What a file read with `print` is to `task`'s last counted refusal.
enum Recount {
    /// Another file, or none: an answer of its own.
    New,
    /// The counted file, read again for the first time: set aside as refused at its count.
    Again(u32),
    /// The counted file, read again once more: no new answer.
    Missing(u32),
}

fn recount<K: Kind>(task: &mut Task<K>, print: Option<&str>) -> Recount {
    let Some(c) = task
        .counted
        .as_mut()
        .filter(|c| print == Some(c.print.as_str()))
    else {
        return Recount::New;
    };
    if c.again {
        Recount::Missing(c.at)
    } else {
        c.again = true;
        Recount::Again(c.at)
    }
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
            // `counted` stays: a refused file still in place is no new answer when read again.
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
