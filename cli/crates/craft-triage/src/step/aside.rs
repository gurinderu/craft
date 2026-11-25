//! The refused answer files moved aside once the state counting their refusal is saved, as the
//! review moves its own (`set_aside` and `unmoved_note` in `craft-review`'s step): one that cannot
//! be moved stays where its agent wrote it, and the run notes what its next read does.

use std::path::Path;

use craft_step::{Aside, Unmoved, take};

use crate::TriageError;
use crate::run::Phase;
use crate::state::{self, TriageState};

/// The note on a refused answer file `u` left in place, saying what its next read does.
fn unmoved_note(s: &TriageState, u: &Unmoved) -> String {
    let pending = s
        .tasks
        .iter()
        .find(|t| t.id == u.id)
        .filter(|t| s.phase != Phase::Done && t.pending());
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
    format!(
        "{}: a refused answer file left in place ({}); {then}",
        u.id,
        craft_review::sources::chain(&u.error)
    )
}

/// Moves the refused answers aside, notes each it could not move and saves the run again. Once the
/// run is done the note is information alone: a failed save of it is let go, so the finished step
/// is still returned.
///
/// # Errors
/// When that save fails while the run goes on.
pub(super) fn set_aside(dir: &Path, s: &mut TriageState, aside: Aside) -> Result<(), TriageError> {
    let unmoved = aside.apply();
    if unmoved.is_empty() {
        return Ok(());
    }
    let notes: Vec<String> = unmoved.iter().map(|u| unmoved_note(s, u)).collect();
    take::note(&mut s.notes, &notes);
    match state::save(dir, s) {
        Err(e) if s.phase != Phase::Done => Err(e.into()),
        Ok(()) | Err(_) => Ok(()),
    }
}
