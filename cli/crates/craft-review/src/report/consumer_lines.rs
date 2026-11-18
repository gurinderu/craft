//! The report's lines on the CONSUMERS lines no lens marked per line (realm @nick/craft, node
//! #531): those an answer left, those shown only to lenses that did not answer, and under unit
//! mode those no lens was shown — handed to the seam pass when every one answered, else unmarked
//! with why.

use crate::consumers::gap_line;
use crate::state::RunState;

/// Each non-empty line, and whether it is also a degraded note: all but the lines a seam pass read.
pub(super) fn all(state: &RunState) -> Vec<(String, bool)> {
    let (handed, unread) = seam_split(state);
    [
        (gap_line("no lens marked", &state.rounds.unmarked()), true),
        (
            gap_line(
                "shown only to lenses that did not answer",
                &state.rounds.unanswered(),
            ),
            true,
        ),
        (
            gap_line("no lens marked, the seam pass did not run", &unread),
            true,
        ),
        (
            gap_line("handed to the seam pass, not marked per line", &handed),
            false,
        ),
    ]
    .into_iter()
    .filter(|(line, _)| !line.is_empty())
    .collect()
}

/// Under unit mode, the lines no lens task was shown: handed to the seam pass when it answered on
/// every track that has units, else left unread by it.
fn seam_split(state: &RunState) -> (Vec<String>, Vec<String>) {
    let mut tracks = state
        .units
        .tracks
        .iter()
        .filter(|t| !t.units.is_empty())
        .peekable();
    if tracks.peek().is_none() {
        return (Vec::new(), Vec::new());
    }
    let unshown = state.rounds.unshown(&state.context.consumers.sites());
    if tracks.all(|t| t.seam.is_some()) {
        (unshown, Vec::new())
    } else {
        (Vec::new(), unshown)
    }
}
