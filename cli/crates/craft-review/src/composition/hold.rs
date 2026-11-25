//! The lenses a composition turns off, held out of a track's plan (realm @nick/craft, node #644).

use super::{Composition, of_profile};
use crate::plan::Plan;

/// Leaves the lenses `c` turns off out of `plan`, the plan of `profile`, and out of every list of
/// what it held back for another reason, so none is a candidate the critic may buy back or a
/// coverage gap; each is named in its `profile_off`. What the run asked for itself, `asked` —
/// strict mode's maintainability lens, an optional lens it bought — stays: the run's own word is
/// the later one. A part the composition would leave with no lens keeps its planned lenses: an
/// Approve on nothing read would read as clean. The lines returned say what gave way, for the run's
/// notes.
#[must_use]
pub(crate) fn hold(
    plan: &mut Plan,
    c: &Composition,
    profile: &str,
    asked: &[String],
) -> Vec<String> {
    let (kept, mut off): (Vec<String>, Vec<String>) = of_profile(&c.off, profile)
        .map(str::to_owned)
        .partition(|l| asked.contains(l));
    let mut notes = Vec::new();
    if !kept.is_empty() {
        notes.push(format!(
            "the run asks for {profile}'s {} itself: the reviewer's profile turning it off gives way",
            kept.join(", ")
        ));
    }
    let every = !plan.lenses.is_empty() && plan.lenses.iter().all(|l| off.contains(l));
    if every {
        notes.push(format!(
            "the reviewer's profile would turn off every lens planned for {profile}'s part ({}): they all run",
            plan.lenses.join(", ")
        ));
        off.retain(|l| !plan.lenses.contains(l));
    }
    for list in [
        &mut plan.lenses,
        &mut plan.metrics_dropped,
        &mut plan.signal_skipped,
        &mut plan.light_skipped,
        &mut plan.data_skipped,
        &mut plan.surface_dropped,
    ] {
        list.retain(|l| !off.contains(l));
    }
    plan.profile_off = off;
    notes
}
