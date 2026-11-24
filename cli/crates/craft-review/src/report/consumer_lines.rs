//! The report's lines on the CONSUMERS lines no lens marked per line (realm @nick/craft, node
//! #531): those an answer left, those shown only to lenses that did not answer, and those no lens
//! was shown — under unit mode handed to the seam pass when their own track's answered and its
//! part holds them, else unmarked with why; any other cut by every lens task's budget (realm
//! `@nick/craft`, node #625).

use crate::consumers::gap_line;
use crate::state::RunState;

/// Each non-empty line, and whether it is also a degraded note: all but the lines a seam pass read.
pub(super) fn all(state: &RunState) -> Vec<(String, bool)> {
    let Unshown {
        handed,
        unread,
        cut,
    } = seam_split(state);
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

/// The CONSUMERS lines no lens task was shown, by what became of them.
#[derive(Default)]
struct Unshown {
    /// Read by their track's seam pass, which answered.
    handed: Vec<String>,
    /// In the seam pass's part, but it did not answer.
    unread: Vec<String>,
    /// In no lens task's part and not the seam pass's: cut by the budgets.
    cut: Vec<String>,
}

/// The lines no lens task was shown: under unit mode, those in the seam pass's part handed to it
/// when the seam pass of their own track — the profile handed the list
/// ([`crate::consumers::PROFILE`]) — answered, else left unread by it, the rest cut; outside unit
/// mode all cut, none when no lens task was shown any line (no lens of the list's track ran).
fn seam_split(state: &RunState) -> Unshown {
    let unshown = state.rounds.unshown(&state.context.consumers.sites());
    let Some(track) = state
        .units
        .tracks
        .iter()
        .find(|t| t.profile == crate::consumers::PROFILE && !t.units.is_empty())
    else {
        if state.rounds.consumers_shown.is_empty() {
            return Unshown::default();
        }
        return Unshown {
            cut: unshown,
            ..Unshown::default()
        };
    };
    let seam = crate::consumers::seam_sites(&state.context.consumers);
    let (theirs, cut): (Vec<String>, Vec<String>) =
        unshown.into_iter().partition(|s| seam.contains(s));
    if track.seam.is_some() {
        Unshown {
            handed: theirs,
            cut,
            ..Unshown::default()
        }
    } else {
        Unshown {
            unread: theirs,
            cut,
            ..Unshown::default()
        }
    }
}
