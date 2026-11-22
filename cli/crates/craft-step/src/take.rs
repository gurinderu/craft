//! Taking a submit's answers, whatever the kind: the abandoned tasks failed, each pending answer
//! read (from `given` or its file) and checked, a refused one asked for again until its retries are
//! spent, or held uncounted.

use std::path::Path;

use serde_json::{Map, Value};

use crate::handoff::{self, HandoffError};
use crate::task::{Task, TaskState};
use crate::validate;

/// What a kind of run adds to taking an answer; each hook's default adds nothing.
pub trait Kind: Sized {
    /// The failure of a task whose raw `answer` says its agent could not do the work, read before
    /// the answer is held to its schema; `None`, it did not say so.
    fn blocked(_task: &Task<Self>, _answer: &Value) -> Option<String> {
        None
    }

    /// The answer `task` can use, as JSON, or why not in one line: by default, the answer as it
    /// matches the task's schema; a kind adds its own checks after the schema's.
    ///
    /// # Errors
    /// Why the answer is refused, in one line.
    fn check(task: &Task<Self>, answer: &Value) -> Result<Value, String> {
        validate::check(&task.schema, Some(answer))
    }

    /// What the kind keeps of an accepted `answer` beside it.
    fn taken(_task: &mut Task<Self>, _answer: &Value) {}
}

/// Which failed answers wait uncounted rather than use up a retry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hold {
    Nothing,
    /// The missing ones (a resume).
    Missing,
    /// Every one (the host's limit).
    Every,
}

impl Hold {
    /// Every answer on the host's `limit`, the missing ones on a `resume`, else none.
    #[must_use]
    pub const fn of(limit: bool, resume: bool) -> Self {
        match (limit, resume) {
            (true, _) => Self::Every,
            (false, true) => Self::Missing,
            (false, false) => Self::Nothing,
        }
    }
}

/// The first id of `given` that names no pending task.
#[must_use]
pub fn unknown<'a, K>(
    tasks: &[Task<K>],
    given: Option<&'a Map<String, Value>>,
) -> Option<&'a String> {
    let pending = |id: &str| tasks.iter().any(|t| t.id == id && t.pending());
    given.and_then(|g| g.keys().find(|id| !pending(id)))
}

/// Keeps each of `notes` once in `kept`, trimmed, the empty ones dropped.
pub fn note(kept: &mut Vec<String>, notes: &[String]) {
    for note in notes.iter().map(|n| n.trim()).filter(|n| !n.is_empty()) {
        if !kept.iter().any(|d| d == note) {
            kept.push(note.to_owned());
        }
    }
}

/// Fails each pending task of `ids`, abandoned by the host at its deadline: a dead agent not
/// dispatched again, whose wait already spent the budget. Its answer file, should one be there, is
/// set aside unread.
///
/// # Errors
/// When an answer file cannot be moved aside.
pub fn abandon<K>(dir: &Path, tasks: &mut [Task<K>], ids: &[String]) -> Result<(), HandoffError> {
    for task in tasks
        .iter_mut()
        .filter(|t| t.pending() && ids.contains(&t.id))
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

/// Takes the answer of every pending task (`take_answer`); says whether any agent answered at all.
///
/// # Errors
/// As [`take_answer`].
pub fn take_pending<K: Kind>(
    dir: &Path,
    tasks: &mut [Task<K>],
    given: Option<&Map<String, Value>>,
    hold: Hold,
) -> Result<bool, HandoffError> {
    let mut live = false;
    for task in tasks.iter_mut().filter(|t| t.pending()) {
        live |= take_answer(dir, task, given, hold)?;
    }
    Ok(live)
}

mod answer;

pub use answer::take_answer;
