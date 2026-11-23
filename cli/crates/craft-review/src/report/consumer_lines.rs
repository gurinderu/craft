//! The report's lines on the CONSUMERS lines no lens marked per line (realm @nick/craft, node
//! #531): those an answer left, those shown only to lenses that did not answer, and those no lens
//! was shown — under unit mode handed to the seam pass when their own track's answered and its
//! part holds them, else unmarked with why; any other cut by every lens task's budget (realm
//! `@nick/craft`, node #625).

use crate::consumers::gap_line;
use crate::state::RunState;

/// Each non-empty line, and whether it is also a degraded note: all but the lines a seam pass read.
pub(super) fn all(state: &RunState) -> Vec<(String, bool)> {
    let (handed, unread, cut) = seam_split(state);
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
        (
            gap_line(
                "cut from every lens's prompt by its budget, in the whole list's file only",
                &cut,
            ),
            false,
        ),
    ]
    .into_iter()
    .filter(|(line, _)| !line.is_empty())
    .collect()
}

/// The lines no lens task was shown: under unit mode, handed to the seam pass when the seam pass
/// of their own track — the profile handed the list ([`crate::consumers::PROFILE`]) — answered and
/// its part holds them, else left unread by it; every other one cut by the lens tasks' budget.
/// None when no lens task was shown any line: no lens of the list's track ran.
fn seam_split(state: &RunState) -> (Vec<String>, Vec<String>, Vec<String>) {
    let none = (Vec::new(), Vec::new(), Vec::new());
    if state.rounds.consumers_shown.is_empty() {
        return none;
    }
    let unshown = state.rounds.unshown(&state.context.consumers.sites());
    let Some(track) = state
        .units
        .tracks
        .iter()
        .find(|t| t.profile == crate::consumers::PROFILE && !t.units.is_empty())
    else {
        return (Vec::new(), Vec::new(), unshown);
    };
    let seam = crate::consumers::seam_sites(&state.context.consumers);
    let (theirs, cut): (Vec<String>, Vec<String>) =
        unshown.into_iter().partition(|s| seam.contains(s));
    if track.seam.is_some() {
        (theirs, Vec::new(), cut)
    } else {
        (Vec::new(), theirs, cut)
    }
}
