//! A metrics-only lens that never returned is a coverage gap, not a review that could not run: it
//! judges only numbers the graph holds, and every other lens still read the change. It caps the
//! verdict at Warning, never Approve, and the verdict line names it when it is what holds the
//! verdict; INCOMPLETE stays for what the review itself needed (`not_run`). Findings still raise
//! the verdict as ever, and every gap is named beside what did not run, whatever the verdict.

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

/// What did not run, as the report's "Not run", the finished step and the run's record name it:
/// `not_run`, then each coverage gap, marked as one.
pub(super) fn named(state: &RunState) -> Vec<String> {
    let gaps = state
        .capped
        .iter()
        .map(|g| format!("{g} (a coverage gap: it caps the verdict at Warning, never Approve)"));
    state.not_run.iter().cloned().chain(gaps).collect()
}
