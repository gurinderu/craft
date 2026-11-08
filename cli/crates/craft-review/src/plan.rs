//! The plan of a profile's review from its scout's answer, as `planFromScout` and
//! `applyLightProfile` in `lib/review-plan.mjs` build it: rigor by size, the scout's picks, the
//! required lenses, the rigor floors, the surface gate and the light pass, in that order.
//! `content/parity/plan-cases.json` holds both ports to the same plans.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent::Model;
use crate::paths::{changes_production_code, is_contract_path};
use crate::profile::Profile;

/// At most this many repository rule files reach a lens prompt, as `REPO_RULES_MAX`.
pub(crate) const REPO_RULES_MAX: usize = 5;
/// And at most this many characters of their joined paths, as `REPO_RULES_MAX_CHARS`.
const REPO_RULES_MAX_CHARS: usize = 120;

/// What a profile's review runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub size_bucket: String,
    pub lenses: Vec<String>,
    pub max_rounds: u32,
    pub verify_votes: u32,
    pub is_library: bool,
    pub security_sensitive: bool,
    pub intent: String,
    pub spec: String,
    pub churn: Vec<String>,
    pub repo_rules: Vec<String>,
    /// Lenses the surface gate dropped.
    pub surface_dropped: Vec<String>,
    /// Whole-diff lenses a light pass did not dispatch.
    pub light_skipped: Vec<String>,
    /// The metrics-or-nothing lenses dropped for want of a code-metrics index. Optional, so a
    /// state written before it reads as a plan that dropped none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub metrics_dropped: Vec<String>,
}

impl Plan {
    /// The model its lenses run on, as the engine's `plan.lensModel`: its first lens's in
    /// `profile`, Opus when it plans none.
    #[must_use]
    pub fn lens_model(&self, profile: &Profile) -> Model {
        self.lenses
            .first()
            .and_then(|l| profile.lens(l))
            .map_or(Model::Opus, |l| l.model)
    }
}

/// What a plan is built from.
#[derive(Debug, Clone, Copy)]
pub struct PlanInput<'a> {
    pub profile: &'a Profile,
    /// The scout's answer; `None` when it gave none, for the conservative plan.
    pub scout: Option<&'a Value>,
    pub changed_files: &'a [String],
    pub spec: &'a str,
    pub light: bool,
    /// Strict mode: the plan carries `maintainability` whatever the scout picked.
    pub strict: bool,
    /// Whether a code-metrics index covers the repository: without one the metrics-or-nothing
    /// lenses are dropped.
    pub metrics: bool,
}

/// Rounds and verifier votes by size, as `RIGOR_BY_SIZE`.
fn rigor(size: &str) -> (u32, u32) {
    match size {
        "small" => (1, 1),
        "large" => (3, 3),
        _ => (2, 1),
    }
}

fn push_missing(lenses: &mut Vec<String>, l: &str) {
    if !lenses.iter().any(|x| x == l) {
        lenses.push(l.to_owned());
    }
}

/// The roster as a blanket fill takes it: no conditional lens, nothing of the optional pass (no
/// run of the CLI requests it).
fn blanket(p: &Profile) -> Vec<String> {
    p.lenses
        .iter()
        .filter(|l| !l.conditional && !l.optional)
        .map(|l| l.id.clone())
        .collect()
}

fn scout_str<'a>(scout: Option<&'a Value>, k: &str) -> Option<&'a str> {
    scout.and_then(|s| s.get(k)).and_then(Value::as_str)
}

fn scout_strings(scout: Option<&Value>, k: &str) -> Vec<String> {
    scout
        .and_then(|s| s.get(k))
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// The scout's rule-file paths as the engine keeps them, as `repoRulePaths`.
fn repo_rule_paths(raw: &[String]) -> Vec<String> {
    let safe = |s: &str| {
        (1..=100).contains(&s.len())
            && !s.starts_with('/')
            && !s.split('/').any(|seg| seg == "..")
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-' | b'/'))
    };
    let mut out: Vec<String> = Vec::new();
    let mut chars = 0;
    for p in raw {
        let s = p.trim();
        let s = s.strip_prefix("./").unwrap_or(s);
        if !safe(s) || out.iter().any(|o| o == s) || chars + s.len() > REPO_RULES_MAX_CHARS {
            continue;
        }
        out.push(s.to_owned());
        chars += s.len();
        if out.len() == REPO_RULES_MAX {
            break;
        }
    }
    out
}

/// Whether the scout, having read the diff, chose `reconciler`: the controller-code signal.
fn chose_reconciler(scout: Option<&Value>) -> bool {
    scout_strings(scout, "lenses")
        .iter()
        .any(|l| l == "reconciler")
}

/// The plan for `input`.
#[must_use]
pub fn plan(input: PlanInput<'_>) -> Plan {
    let PlanInput {
        profile: p,
        scout,
        changed_files: files,
        ..
    } = input;
    let size = scout_str(scout, "sizeBucket")
        .filter(|s| matches!(*s, "small" | "medium" | "large"))
        .unwrap_or("medium");
    let (max_rounds, verify_votes) = rigor(size);
    let picked = scout_strings(scout, "lenses");
    let mut lenses: Vec<String> = Vec::new();
    for l in picked
        .iter()
        .filter(|l| p.lens(l).is_some_and(|x| p.offers(l) && !x.optional))
    {
        push_missing(&mut lenses, l);
    }
    if lenses.is_empty() {
        lenses = blanket(p);
    }
    let mut plan = Plan {
        size_bucket: size.to_owned(),
        lenses,
        max_rounds,
        verify_votes,
        is_library: p.uses_library
            && scout
                .and_then(|s| s.get("isLibrary"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
        security_sensitive: scout
            .and_then(|s| s.get("securitySensitive"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
        intent: scout_str(scout, "intent").unwrap_or("").to_owned(),
        spec: input.spec.to_owned(),
        churn: scout_strings(scout, "churn"),
        repo_rules: repo_rule_paths(&scout_strings(scout, "repoRules")),
        surface_dropped: Vec::new(),
        light_skipped: Vec::new(),
        metrics_dropped: Vec::new(),
    };
    required(p, scout, files, &mut plan);
    if input.strict && p.offers("maintainability") {
        push_missing(&mut plan.lenses, "maintainability");
    }
    floors(p, files, &mut plan);
    surface_gate(p, scout, files, &mut plan);
    if !input.metrics {
        let metrics = p.flagged(|l| l.metrics);
        let (dropped, kept) = plan.lenses.drain(..).partition(|l| metrics.contains(l));
        plan.lenses = kept;
        plan.metrics_dropped = dropped;
    }
    if input.light {
        light(p, scout, files, &mut plan);
    }
    plan
}

/// The lenses the plan carries whatever the scout picked: the always set, `tests` on a change to
/// production code, `failure-windows` on controller code.
fn required(p: &Profile, scout: Option<&Value>, files: &[String], plan: &mut Plan) {
    let mut offer = |l: &str| {
        if p.offers(l) {
            push_missing(&mut plan.lenses, l);
        }
    };
    for l in &p.always_lenses {
        offer(l);
    }
    if changes_production_code(files, &p.diff_globs) {
        offer("tests");
    }
    if chose_reconciler(scout) {
        offer("failure-windows");
    }
}

/// The security floor, negative-space where new surface appears (on a profile that has the lens),
/// and compat on large diffs and contract paths.
fn floors(p: &Profile, files: &[String], plan: &mut Plan) {
    if plan.security_sensitive {
        for l in blanket(p) {
            push_missing(&mut plan.lenses, &l);
        }
        plan.verify_votes = plan.verify_votes.max(3);
        plan.max_rounds = plan.max_rounds.max(2);
    }
    let large = plan.size_bucket == "large";
    if (plan.security_sensitive || large) && p.lens("negative-space").is_some() {
        push_missing(&mut plan.lenses, "negative-space");
    }
    if (large || files.iter().any(|f| is_contract_path(f))) && p.offers("compat") {
        push_missing(&mut plan.lenses, "compat");
    }
}

/// Drops each surface-gated lens whose surface the scout said, in so many words, is absent.
fn surface_gate(p: &Profile, scout: Option<&Value>, files: &[String], plan: &mut Plan) {
    let forced = files.iter().any(|f| is_contract_path(f));
    let surfaces = scout.and_then(|s| s.get("surfaces"));
    let absent = |need: &str| {
        let on = forced && matches!(need, "crossBoundarySymbol" | "wireForm");
        !on && surfaces.and_then(|s| s.get(need)) == Some(&Value::Bool(false))
    };
    let (kept, dropped): (Vec<String>, Vec<String>) = plan.lenses.drain(..).partition(|l| {
        p.lens(l)
            .and_then(|x| x.surface.as_deref())
            .is_none_or(|need| !absent(need))
    });
    plan.lenses = kept;
    plan.surface_dropped = dropped;
}

/// The light pass: the diff-scoped lenses and those the diff calls for, one round.
fn light(p: &Profile, scout: Option<&Value>, files: &[String], plan: &mut Plan) {
    let in_roster = |ls: &[&str]| -> Vec<String> {
        ls.iter()
            .filter(|l| p.offers(l))
            .map(|l| (*l).to_owned())
            .collect()
    };
    let mut forced = Vec::new();
    if changes_production_code(files, &p.diff_globs) {
        forced.extend(in_roster(&["tests", "intent"]));
    }
    if chose_reconciler(scout) {
        forced.extend(in_roster(&["reconciler", "failure-windows"]));
    }
    if files.iter().any(|f| is_contract_path(f)) {
        forced.extend(in_roster(&["compat"]));
    }
    let whole = p.flagged(|l| l.whole_diff);
    let scoped = |l: &String| !whole.contains(l) || forced.contains(l);
    let mut kept: Vec<String> = plan.lenses.iter().filter(|l| scoped(l)).cloned().collect();
    if kept.is_empty() {
        kept = blanket(p).into_iter().filter(|l| scoped(l)).collect();
    }
    let mut out = Vec::new();
    for l in kept.iter().chain(&forced) {
        push_missing(&mut out, l);
    }
    plan.light_skipped = plan.lenses.iter().filter(|l| !scoped(l)).cloned().collect();
    plan.lenses = out;
    plan.max_rounds = 1;
}

#[cfg(test)]
mod parity;
