//! What a report says about the review it does not claim: the light pass's mark and section, as
//! `markVerdictLight` and `lightSection` in `lib/review-depth.mjs` word them (realm @nick/craft,
//! node #295), and the parts of craft:review this CLI does not run.

use crate::profile::Profile;
use crate::state::RunState;

/// The parts of craft:review the CLI does not run, each named once so a later slice that ports one
/// removes its item and nothing else.
const CLI_NOT_RUN: [&str; 6] = [
    "clippy gate seeds",
    "the completeness critic",
    "unit slicing and the contract lens",
    "extra and role lenses",
    "the external-sources block",
    "project memory",
];

/// The not-run line that says what this CLI's review leaves out by construction. It is a scope
/// statement, not a failure: a re-run will not add these, so it does not make the verdict
/// INCOMPLETE.
pub(super) fn cli_not_run() -> String {
    format!(
        "not part of this CLI's review (it runs the Rust profile's lenses, the dedup and the verification only; a re-run will not add these): {}",
        CLI_NOT_RUN.join(" · ")
    )
}

/// The verdict line marked as a light pass's, once.
pub(super) fn mark(line: &str) -> String {
    if line.to_lowercase().contains("light pass") {
        return line.to_owned();
    }
    format!("{line} · light pass (depth=light) -- see \"Light pass\" below for what it skipped")
}

/// What the light pass did not do, stated on every report it returns.
pub(super) fn section(state: &RunState) -> String {
    let Some(plan) = state.plan.as_ref().filter(|_| state.exit.is_none()) else {
        return "\n\n## Light pass -- no lens ran\n⚠️ This was a LIGHT pass (depth=light), and it ended before any lens ran, so it makes no statement about the code. Re-run once the cause above is fixed.\n".into();
    };
    let lenses = if plan.light_skipped.is_empty() {
        "no whole-diff lens was in the plan to skip".to_owned()
    } else {
        format!(
            "the whole-diff lenses {} were NOT dispatched",
            plan.light_skipped.join(", ")
        )
    };
    let whole = Profile::rust()
        .map(|p| p.flagged(|l| l.whole_diff))
        .unwrap_or_default();
    let kept: Vec<&str> = plan
        .lenses
        .iter()
        .filter(|l| whole.contains(l))
        .map(String::as_str)
        .collect();
    let kept = if kept.is_empty() {
        String::new()
    } else {
        format!(
            " (it DID run {}, which the diff called for)",
            kept.join(", ")
        )
    };
    format!(
        "\n\n## Light pass -- what it skipped\n⚠️ This was a LIGHT pass (depth=light), not a full review, and its verdict covers only what it ran: {lenses}{kept}; the lenses ran ONE round (no loop-until-dry); the completeness critic did not run; Low and Info findings were not verified (each says so in its `why`), except those two or more lenses reported with a must-fix harm claimed, which were. That is an absence of a result, not a clean one. Re-run without `depth` (or with `depth=full`) for the full review.\n"
    )
}
