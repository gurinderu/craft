//! Taking a submit's answers: the abandoned tasks failed, each pending answer read and checked,
//! and the run moved on or held.

use std::path::Path;

use serde_json::{Map, Value};

use super::Said;
use crate::Error;
use crate::blocked;
use crate::handoff;
use crate::phases::advance;
use crate::state::{MAX_RETRIES, Phase, RunState, Task, TaskState};
use crate::stop;
use crate::validate;

/// Which failed answers wait uncounted rather than use up a retry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Hold {
    Nothing,
    /// The missing ones (a resume).
    Missing,
    /// Every one (the host's limit).
    Every,
}

/// Fails each pending task of `ids`, abandoned by the host at its deadline, as the engine counts a
/// deadline fire: a dead agent not dispatched again, whose wait already spent the budget. Its
/// answer file, should one be there, is set aside unread.
pub(super) fn abandon(dir: &Path, run: &mut RunState, ids: &[String]) -> Result<(), Error> {
    for task in run
        .tasks
        .iter_mut()
        .filter(|t| t.state == TaskState::Pending && ids.contains(&t.id))
    {
        handoff::set_aside(dir, task)?;
        task.state = TaskState::Failed;
        task.abandoned = true;
        task.error = Some(
            "abandoned at its deadline: the host waited its whole budget and no answer came back, so it is not asked for again".into(),
        );
    }
    Ok(())
}

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

/// Takes the answer of one pending task, from `given` or the file its agent wrote; one refused is
/// asked for again until its retries are spent — unless `hold` keeps it waiting uncounted: every
/// one on the host's limit, a missing one on a resume (handed out again as first written). Says
/// whether its agent answered at all, valid or not.
pub(super) fn take_answer(
    dir: &Path,
    task: &mut Task,
    given: Option<&Map<String, Value>>,
    hold: Hold,
) -> Result<bool, Error> {
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
    // An agent that could not look fails with its reason at once, its findings dropped and before
    // its schema is checked: an empty answer from it would read as a clean review, and one that
    // left out a required field would otherwise lose that reason to a refusal and its retries
    // (realm @nick/craft, node #511).
    if let Some(why) = submitted
        .as_ref()
        .ok()
        .and_then(|a| blocked::said(&task.schema, a))
    {
        task.state = TaskState::Failed;
        task.error = Some(blocked::failure(&why));
        task.refused = None;
        return Ok(true);
    }
    let checked = submitted
        .as_ref()
        .map_err(Clone::clone)
        .and_then(|a| validate::check(task, Some(a)));
    match checked {
        Ok(answer) => {
            // The CONSUMERS lines it left unmarked are taken with it, to be reported as unchecked,
            // never asked for again (realm @nick/craft, node #531).
            task.unmarked = validate::unmarked(&answer, &task.consumers);
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
    match hold {
        Hold::Every => return Ok(live),
        Hold::Missing if !live => {
            // Handed out again as first written, its ladder whole, as `stop::hold` holds a task.
            task.retries = 0;
            task.error = None;
            task.refused = None;
            return Ok(false);
        }
        Hold::Missing | Hold::Nothing => {}
    }
    if task.retries < MAX_RETRIES {
        task.retries += 1;
    } else {
        task.state = TaskState::Failed;
    }
    Ok(live)
}
