//! A metrics-only lens that never returned is a coverage gap, not a review that could not run: it
//! judges only numbers the graph holds, and every other lens still read the change. It caps the
//! verdict at Warning, never Approve, and the verdict line names it; INCOMPLETE stays for what the
//! review itself needed (`not_run`). Findings still raise the verdict as ever.

use crate::state::RunState;

/// `worst` with the gap's cap: an Approve becomes a Warning, any other verdict stands.
pub(super) fn cap<'a>(state: &RunState, worst: &'a str) -> &'a str {
    if worst == "Approve" && !state.capped.is_empty() {
        "Warning"
    } else {
        worst
    }
}

/// Why the gap holds the verdict, when it turned `uncapped` (the verdict before it, the gate's cap
/// applied) from Approve into a Warning; `None` otherwise, and when something the review needed did
/// not run: INCOMPLETE then names the cause.
pub(super) fn reason(state: &RunState, uncapped: &str) -> Option<String> {
    let holds = uncapped == "Approve" && !state.capped.is_empty() && state.not_run.is_empty();
    holds.then(|| {
        format!(
            "a coverage gap holds it at Warning, never Approve: {}",
            state.capped.join(" · ")
        )
    })
}
