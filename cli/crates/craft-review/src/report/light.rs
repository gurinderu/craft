//! What a report says about the review it does not claim: the light pass's mark and section, as
//! `markVerdictLight` and `lightSection` in `lib/review-depth.mjs` word them (realm @nick/craft,
//! node #295), and the parts of craft:review this CLI does not run.

use crate::plan::Plan;
use crate::profile::Profile;
use crate::state::RunState;

/// Adds `l` to `list` unless it is there.
fn push_once<'a>(list: &mut Vec<&'a str>, l: &'a str) {
    if !list.contains(&l) {
        list.push(l);
    }
}

/// The parts of craft:review the CLI does not run, each named once so a later slice that ports one
/// removes its item and nothing else.
const CLI_NOT_RUN: [&str; 6] = [
    "the gate and its tool seeds (clippy and semgrep for Rust; nix flake check, statix and deadnix for Nix)",
    "the completeness critic",
    "unit slicing and the contract lens",
    "extra and role lenses",
    "the external-sources block",
    "the project rules memory recalls (a rule covers no finding) and the match judge (a remembered record that meets a finding only by a near line or some shared title words sets it aside by the title rule alone)",
];

/// The not-run line that says what this CLI's review leaves out by construction. It is a scope
/// statement, not a failure: a re-run will not add these, so it does not make the verdict
/// INCOMPLETE. A run the general profile took part in also names the lens that profile leaves out.
pub(super) fn cli_not_run(state: &RunState) -> String {
    let mut parts = CLI_NOT_RUN.to_vec();
    if state
        .tracks
        .iter()
        .any(|t| t.profile == "general" && t.plan.is_some())
    {
        parts.insert(2, GENERAL_NOT_RUN);
    }
    if state.chain.prior.is_some() {
        parts.push(REREVIEW_NOT_RUN);
    }
    format!(
        "not part of this CLI's review (it runs the lenses of its Rust, Nix and general profiles, the dedup, the verification and the project memory's decisions and deferred questions only; a re-run will not add these): {}",
        parts.join(" · ")
    )
}

/// What the general profile leaves out of adversarial-review's catalog until its metrics gate is
/// ported.
const GENERAL_NOT_RUN: &str = "the general profile's complexity lens (needs a code-metrics index)";

/// What a re-review leaves out of the engine's adjudicate track until it is ported.
const REREVIEW_NOT_RUN: &str =
    "the re-review's red team on a resolved Critical or High prior finding";

/// The verdict line marked as a light pass's, once.
pub(super) fn mark(line: &str) -> String {
    if line.to_lowercase().contains("light pass") {
        return line.to_owned();
    }
    format!("{line} · light pass (depth=light) -- see \"Light pass\" below for what it skipped")
}

/// What the light pass did not do, stated on every report it returns.
pub(super) fn section(state: &RunState) -> String {
    let plans: Vec<(&str, &Plan)> = state
        .tracks
        .iter()
        .filter_map(|t| Some((t.profile.as_str(), t.plan.as_ref()?)))
        .collect();
    if plans.is_empty() || state.exit.is_some() {
        return "\n\n## Light pass -- no lens ran\n⚠️ This was a LIGHT pass (depth=light), and it ended before any lens ran, so it makes no statement about the code. Re-run once the cause above is fixed.\n".into();
    }
    let mut skipped: Vec<&str> = Vec::new();
    let mut kept: Vec<&str> = Vec::new();
    for (profile, plan) in &plans {
        let whole = Profile::load(profile)
            .map(|p| p.flagged(|l| l.whole_diff))
            .unwrap_or_default();
        for l in &plan.light_skipped {
            push_once(&mut skipped, l);
        }
        for l in plan.lenses.iter().filter(|l| whole.contains(l)) {
            push_once(&mut kept, l);
        }
    }
    let lenses = if skipped.is_empty() {
        "no whole-diff lens was in the plan to skip".to_owned()
    } else {
        format!(
            "the whole-diff lenses {} were NOT dispatched",
            skipped.join(", ")
        )
    };
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
