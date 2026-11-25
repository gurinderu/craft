//! The refused answer files moved aside once the state counting their refusal is saved: one that
//! cannot be moved stays where its agent wrote it, and the run notes what its next read does, as
//! every kind of the step protocol notes it (`craft_step::left`).

use std::path::Path;

use craft_step::{Aside, take};

use crate::TriageError;
use crate::run::Phase;
use crate::state::{self, TriageState};

/// The task `id` while the run still waits for its answer.
fn pending<'a>(s: &'a TriageState, id: &str) -> Option<&'a crate::state::Task> {
    s.tasks
        .iter()
        .find(|t| t.id == id)
        .filter(|t| s.phase != Phase::Done && t.pending())
}

/// Moves the refused answers aside, notes each it could not move and saves the run again. Where
/// only settled tasks' files stay, or the run is done, the note is information alone: a failed save
/// of it is let go, so the step is still returned.
///
/// # Errors
/// When that save fails while a pending task's file stays in place.
pub(super) fn set_aside(dir: &Path, s: &mut TriageState, aside: Aside) -> Result<(), TriageError> {
    let unmoved = aside.apply();
    if unmoved.is_empty() {
        return Ok(());
    }
    let (notes, goes_on) = craft_step::left::left(&unmoved, |id| pending(s, id));
    take::note(&mut s.notes, &notes);
    match state::save(dir, s) {
        Err(e) if goes_on => Err(e.into()),
        Ok(()) | Err(_) => Ok(()),
    }
}

#[cfg(test)]
mod tests;
