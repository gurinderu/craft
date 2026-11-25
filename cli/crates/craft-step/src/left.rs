//! Refused answer files the host's step could not move aside, as every kind of run notes them: what
//! the next read of each does, and whether a failed save of those notes must fail the step (realm
//! @nick/craft, node #610).

use crate::handoff::Unmoved;
use crate::kind::Kind;
use crate::task::Task;

/// An error with each of its sources, one line.
#[must_use]
pub fn chain(e: &dyn std::error::Error) -> String {
    let mut s = e.to_string();
    let mut at = e.source();
    while let Some(c) = at {
        s.push_str(&format!(": {c}"));
        at = c.source();
    }
    s
}

/// The note on a refused answer file `u` left in place, `pending` its task while the run still
/// waits for its answer: what its next read does.
#[must_use]
pub fn note<K: Kind>(pending: Option<&Task<K>>, u: &Unmoved) -> String {
    let then = match pending {
        None => "its task is settled, so it stays there",
        Some(_) if !u.known => "read again, it is taken as a new answer",
        Some(t) if t.counted.as_ref().is_some_and(|c| c.again) => {
            "found there again after a round that ran, it counts as a missing answer"
        }
        Some(_) => {
            "read again, it is set aside uncounted, and found there once more after a round that ran it counts as a missing answer"
        }
    };
    format!("{}: left in place; {then}", chain(&u.error))
}

/// The notes on `unmoved`, each task found by `pending` while the run waits for its answer, and
/// whether a pending task's file stays in place: only then does a failed save of the notes fail
/// the step — once only settled tasks' files stay, the notes are information alone.
#[must_use]
pub fn left<'a, K: Kind + 'a>(
    unmoved: &[Unmoved],
    pending: impl Fn(&str) -> Option<&'a Task<K>>,
) -> (Vec<String>, bool) {
    let notes = unmoved.iter().map(|u| note(pending(&u.id), u)).collect();
    let goes_on = unmoved.iter().any(|u| pending(&u.id).is_some());
    (notes, goes_on)
}

#[cfg(test)]
mod tests;
