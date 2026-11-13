//! The verification phase: which verifiers judge which finding, in the waves `verifyPool` buys
//! them; [`outcome`] settles what their votes say.

use serde_json::Value;

use crate::harm;
use crate::state::RunState;

mod outcome;
#[cfg(test)]
mod route_tests;
mod stopped;
mod waves;
pub(crate) use outcome::settle_run;
pub(crate) use stopped::stood;
use waves::{awaits_escalation, culls, is_high, panel, returned};
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
    /// No verifier: an Info, or a Low citing no rule that blocks on sight and on no failure path,
    /// cannot move the verdict, so it stays unverified.
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

/// The lenses that read failure paths: partial failure, retry, error handling, interleavings.
const FAILURE_PATH_LENSES: [&str; 4] = ["failure-windows", "reconciler", "concurrency", "errors"];
/// The rule families of a failure path: reconcile, concurrency and error handling.
const FAILURE_PATH_RULES: [&str; 3] = ["REC-", "CON-", "ERR-"];

/// The route `f` takes: Critical and High alone, Medium batched, a Low on a failure path batched
/// when a harm it claims could make it must-fix — only a verified harm can raise it, so another
/// buys no verifier (realm @nick/craft, node #407) — other Lows and Info skipped unless they cite
/// a rule that blocks on sight.
pub(crate) fn route(f: &Value) -> Route {
    let sev = f.get("severity").and_then(Value::as_str).unwrap_or("");
    let rule = f.get("ruleId").and_then(Value::as_str).unwrap_or("");
    match sev {
        "Critical" | "High" => Route::Individual,
        "Medium" => Route::Batch,
        _ if CRITICAL_TIER_RULES.contains(&rule) => Route::Individual,
        "Low" if on_failure_path(f) && harm::raise::may_be_must_fix(f) => Route::Batch,
        _ => Route::Skip,
    }
}

/// Whether `f` concerns a failure path: a lens that reads them reported it, it cites a rule of
/// their families, or its lens flagged it on a deletion or recovery path. Such Lows are where a
/// review most often under-rates a defect.
fn on_failure_path(f: &Value) -> bool {
    let rule = f.get("ruleId").and_then(Value::as_str).unwrap_or("");
    f.get("deletionOrRecoveryPath") == Some(&Value::Bool(true))
        || FAILURE_PATH_RULES.iter().any(|p| rule.starts_with(p))
        || lenses(f).iter().any(|l| FAILURE_PATH_LENSES.contains(l))
}

/// The lenses that reported `f`: its `sources`, else its `source` — a gate tool's aside, as
/// `agreeingLenses`: a seed is not an independent reading.
fn lenses(f: &Value) -> Vec<&str> {
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
    lenses
}

/// Whether two or more different lenses reported `f` (`lensAgreed`).
fn lens_agreed(f: &Value) -> bool {
    lenses(f).len() >= 2
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
    let why = if run.light {
        "a light pass verifies only Medium and above, and a finding two lenses agree on with a must-fix harm claimed"
    } else {
        "none is on a failure path or agreed by two lenses with a harm a verifier could raise to must-fix, so none could move the verdict"
    };
    (n > 0).then(|| {
        format!(
            "{n} Low/Info finding(s) NOT VERIFIED: no verifier was spent on them, since {why}; they are reported as unverified"
        )
    })
}
