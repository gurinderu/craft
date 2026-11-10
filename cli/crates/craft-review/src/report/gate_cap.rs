//! A gate signal the review asked for and could not establish caps the verdict at Warning, never
//! Approve, and the verdict line says so with the CI the gate saw (realm @nick/craft, node #487: a
//! green CI check never stands for a gate signal craft did not establish itself). A gate switched
//! off on purpose (`--no-gate`) or a refused `--gate-from` has no track, so it caps nothing;
//! findings still raise the verdict.

use crate::gate::unknown;
use crate::state::RunState;

/// `worst` with an unknown gate's cap: an Approve becomes a Warning, any other verdict stands.
pub(super) fn cap<'a>(state: &RunState, worst: &'a str) -> &'a str {
    if worst == "Approve" && !unknown::profiles(&state.gate).is_empty() {
        "Warning"
    } else {
        worst
    }
}

/// Why an unknown gate holds the verdict, with what CI said of it; `None` when none is unknown.
pub(super) fn reason(state: &RunState) -> Option<String> {
    unknown::reason(&state.gate)
}
