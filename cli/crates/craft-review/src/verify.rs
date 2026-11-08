//! The verification phase: which verifiers judge which finding, in the waves `verifyPool` buys
//! them; [`outcome`] settles what their votes say.

use serde_json::Value;

use crate::harm;
use crate::state::RunState;

mod outcome;
mod waves;
pub(crate) use outcome::settle_run;
use waves::{culls, is_high, panel, returned};
pub(crate) use waves::{escalation, tasks};

/// How many findings one batch verifier judges, as `BATCH_SIZE` in `lib/review-verify.mjs`.
pub(crate) const BATCH_SIZE: usize = 6;
/// Rules that block on sight: a finding citing one is verified on its own whatever its severity.
pub(crate) const CRITICAL_TIER_RULES: &[&str] = &[
    "SAF-001", "SAF-002", "SAF-003", "SAF-004", "SAF-005", "SAF-006", "SAF-008", "ERR-001",
    "ERR-002",
];

/// How a finding is verified, as `verifyTier` in `lib/review-verify.mjs` routes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Route {
    /// A verifier of its own: Critical or High, or citing a rule that blocks on sight.
    Individual,
    /// One verifier judges a batch of them: Medium.
    Batch,
    /// No verifier: a Low or Info citing no rule that blocks on sight cannot move the verdict, so
    /// it stays unverified.
    Skip,
}

impl Route {
    /// The route as the engines name it.
    #[cfg(test)]
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Individual => "individual",
            Self::Batch => "batch",
            Self::Skip => "skip",
        }
    }
}

/// The route `f` takes: Critical and High alone, Medium batched, Low and Info skipped unless they
/// cite a rule that blocks on sight.
pub(crate) fn route(f: &Value) -> Route {
    let sev = f.get("severity").and_then(Value::as_str).unwrap_or("");
    let rule = f.get("ruleId").and_then(Value::as_str).unwrap_or("");
    match sev {
        "Critical" | "High" => Route::Individual,
        "Medium" => Route::Batch,
        _ if CRITICAL_TIER_RULES.contains(&rule) => Route::Individual,
        _ => Route::Skip,
    }
}

/// Whether two or more different lenses reported `f` (`lensAgreed`): its `sources`, else its
/// `source` — a gate tool's aside, as `agreeingLenses`: a seed is not an independent reading.
fn lens_agreed(f: &Value) -> bool {
    let all: Vec<&Value> = match f.get("sources").and_then(Value::as_array) {
        Some(a) => a.iter().collect(),
        None => f.get("source").into_iter().collect(),
    };
    let mut lenses: Vec<&str> = all
        .iter()
        .filter_map(|s| s.as_str())
        .filter(|s| !s.is_empty() && !crate::tool::is_tool_source(s))
        .collect();
    lenses.sort_unstable();
    lenses.dedup();
    lenses.len() >= 2
}

/// The route `f` takes in a run, as `routeOf` in `lib/review-verify-pool.mjs`: a light pass
/// verifies only Medium and above (`depthVerifyTier`), and two or more lenses on one defect buy a
/// verifier when the harm it names could make it must-fix (realm @nick/craft, node #407).
pub(crate) fn route_in(f: &Value, light: bool) -> Route {
    let sev = f.get("severity").and_then(Value::as_str).unwrap_or("");
    let tier = if light && !matches!(sev, "Critical" | "High" | "Medium") {
        Route::Skip
    } else if crate::complexity::is_metric(f) {
        // One verifier re-reads its metrics, whatever its severity, as `buildVerifyJobs` sends it.
        Route::Individual
    } else {
        route(f)
    };
    if tier == Route::Skip && lens_agreed(f) && harm::raise::may_be_must_fix(f) {
        Route::Individual
    } else {
        tier
    }
}

/// The note a run carries when some findings were routed past verification, as the engine's log
/// says it.
pub(crate) fn skipped_note(run: &RunState) -> Option<String> {
    let n = run
        .findings
        .iter()
        .filter(|f| route_in(f, run.light) == Route::Skip)
        .count();
    (n > 0).then(|| {
        format!(
            "{n} Low/Info finding(s) NOT VERIFIED: no verifier was spent on them, since Low and Info cannot change the verdict either way; they are reported as unverified"
        )
    })
}
