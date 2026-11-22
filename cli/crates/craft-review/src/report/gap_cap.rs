//! A metrics-only lens that never returned, or one that could not look (`crate::complexity::Look`),
//! is a coverage gap, not a review that could not run: it judges only numbers the graph holds, and
//! every other lens still read the change. It caps the
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

/// Each coverage gap as the report's "Not run" and the finished step's `capped` name it: marked as
/// one, which holds an otherwise clean verdict at Warning and leaves `not_run` alone.
pub(super) fn named(state: &RunState) -> Vec<String> {
    state
        .capped
        .iter()
        .map(|g| {
            format!("{g} (a coverage gap: alone it holds the verdict at Warning, never Approve)")
        })
        .collect()
}
