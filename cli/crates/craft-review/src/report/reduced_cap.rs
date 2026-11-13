//! A reduced round caps the verdict at Warning, never Approve: a delta round reviews only the fix
//! commits, and a light pass skips the whole-diff lenses and the verification of Lows, so neither
//! has read enough to call the change clean. Approve comes only from a full round; findings still
//! raise the verdict as ever.

use crate::coverage::Exit;
use crate::prompts::ReScope;
use crate::state::RunState;

/// What makes `state` a reduced round, as its verdict line names it; `None` for a full round.
fn reduced(state: &RunState) -> Option<&'static str> {
    if state.context.re_review == ReScope::Fixes || state.delta {
        Some("a delta round that reviewed only the fix commits")
    } else if state.light {
        Some("a light round (depth=light)")
    } else {
        None
    }
}

/// `worst` with a reduced round's cap: an Approve becomes a Warning, any other verdict stands.
pub(super) fn cap<'a>(state: &RunState, worst: &'a str) -> &'a str {
    if worst == "Approve" && reduced(state).is_some() {
        "Warning"
    } else {
        worst
    }
}

/// Whether a reduced round overrides `exit`'s own Approve (nothing reviewable in the change): a
/// delta over docs alone still says nothing of the earlier rounds' concerns.
pub(super) fn over_exit(state: &RunState, exit: &Exit) -> bool {
    reduced(state).is_some() && exit.verdict.starts_with("Approve")
}

/// Why a reduced round holds the verdict, when it turned `uncapped` (the verdict before the cap,
/// the gate's applied) from Approve into a Warning; `None` otherwise, and when something did not
/// run: INCOMPLETE then names the cause, not the cap.
pub(super) fn reason(state: &RunState, uncapped: &str) -> Option<String> {
    let exit_approves = state.exit.as_ref().is_none_or(|e| over_exit(state, e));
    let holds = uncapped == "Approve" && exit_approves && state.not_run.is_empty();
    let what = reduced(state).filter(|_| holds)?;
    Some(format!(
        "{what} never approves: Approve comes only from a full round (the whole diff, `depth=full`)"
    ))
}
