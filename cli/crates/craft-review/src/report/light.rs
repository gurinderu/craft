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

/// The not-run line that says what this CLI's review leaves out by construction. It is a scope
/// statement, not a failure: a re-run will not add these, so it does not make the verdict
/// INCOMPLETE. A run a gated profile took part in also names what its gate leaves out of the
/// engine's, and a run that asked for unit mode what that mode leaves out.
pub(super) fn cli_not_run(state: &RunState) -> String {
    let mut parts = Vec::new();
    if state.units.asked {
        parts.push(crate::units::NOT_RUN);
    }
    let took_part = |id: &str| state.tracks.iter().any(|t| t.profile == id);
    let gated = took_part("rust") || took_part("nix");
    if gated && !state.gate.skipped.is_empty() {
        parts.insert(0, GATE_SKIPPED);
    } else {
        if took_part("rust") {
            parts.insert(0, RUST_GATE_NOT_RUN);
        }
        if took_part("nix") {
            parts.insert(0, NIX_GATE_NOT_RUN);
        }
    }
    if state.chain.prior.is_some() {
        parts.push(REREVIEW_NOT_RUN);
    }
    format!(
        "not part of this CLI's review (it runs the mechanical gate of its Rust and Nix profiles, the lenses of its Rust, Nix and general profiles (each sliceable lens once per directory slice of a change of 12 or more owned files across directories), unit mode when asked (each sliceable lens confined to a batch of crates, a contract lens per touched crate and a coordinator after the rounds), the repository's own reviewing agents as extra lenses, the dedup, the verification, the completeness critic with the lenses it admits, the project memory's decisions, deferred questions and project rules with their judges, the sources of the integration points the reviewer's profile names (`craft init`), a review scoped to one directory (`--path`), a stop on the account's usage limit with a resume through `submit`, and with `--comment` the sorting of the findings into defects and doubtful ones and the defects posted on the PR with the craft-finding marker only; a re-run will not add these): {}",
        if parts.is_empty() {
            "nothing else".to_owned()
        } else {
            parts.join(" · ")
        }
    )
}

/// What the Rust gate leaves out of the engine's: what takes an agent's judgement (CI's checks, the
/// project's own lint recipe, dependency context) or the scout's plan (semver, registry rules).
const RUST_GATE_NOT_RUN: &str = "the Rust gate's reading of CI and of the project's own lint recipe, its tests, cargo audit and cargo deny, cargo semver-checks, semgrep's registry rule sets (p/rust, p/secrets) and the dependency-context seeds";

/// The gate of a run started with `--no-gate`.
const GATE_SKIPPED: &str =
    "the mechanical gate and its tool seeds (skipped on request, `--no-gate`)";

/// What the Nix gate leaves out of the engine's.
const NIX_GATE_NOT_RUN: &str = "the Nix gate's reading of CI, its formatter check, the builds of the touched attributes and the dependency-context seeds";

/// What a re-review leaves out of the engine's adjudicate track until it is ported.
const REREVIEW_NOT_RUN: &str = "the re-review's adjudication in the same round of a deferred prior whose question a record answered (it is kept still open and adjudicated next round)";

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
