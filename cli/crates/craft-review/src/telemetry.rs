//! What the finished step hands the host for the run's record beside the verdict, in the shape
//! review's record keeps it (`dimensions`, `verification` and `lensRounds` in
//! `lib/review-ledger.mjs` and `lib/review-record.mjs`), so the run-store report reads a CLI run's
//! lens yield and refutation as it reads the engine's: one row per lens with what verification
//! made of its findings, and the run's verification counts. Counted as each verification pass
//! settles, before the project's memory sets any finding aside, as the engine counts its tiers.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::settle::Tier;
use crate::state::{RunState, Task, TaskKind, TaskState, finding_profile};

/// The severities a row counts its confirmed findings by, as `countBySeverity` does.
const SEVERITIES: [&str; 5] = ["Critical", "High", "Medium", "Low", "Info"];

/// What verification made of one lens's findings.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LensYield {
    pub confirmed: usize,
    pub suspected: usize,
    pub refuted: usize,
    pub unverified: usize,
    /// The confirmed ones by severity.
    pub by_severity: BTreeMap<String, usize>,
}

/// The run's verification over all its passes.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Verified {
    pub confirmed: usize,
    pub suspected: usize,
    pub refuted: usize,
    pub unverified: usize,
    /// Findings whose verdict was reached with a returned vote discarded as off-schema.
    pub thinned: usize,
    /// Verifier tasks handed out, and those whose agent answered at all.
    pub votes_sent: usize,
    pub votes_returned: usize,
}

/// The run's telemetry between steps. Optional in the state, so a run written before it reads as
/// one with nothing counted yet.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tally {
    /// How many dispatch passes sent each lens, by `profile:lens` (a sliced lens once a pass).
    #[serde(default)]
    pub rounds: BTreeMap<String, u32>,
    /// The lenses any of whose dispatches answered.
    #[serde(default)]
    pub answered: BTreeSet<String>,
    /// Each lens's verified yield, by `profile:lens`.
    #[serde(default)]
    pub lenses: BTreeMap<String, LensYield>,
    /// `None` until a verification pass settled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified: Option<Verified>,
}

/// The `profile:lens` a lens-like task runs: a lens, a critic's lens, a unit-mode coordinator.
fn lens_of(t: &Task) -> Option<String> {
    if let TaskKind::Lens { profile, lens, .. } | TaskKind::CriticLens { profile, lens } = &t.kind {
        return Some(format!("{profile}:{lens}"));
    }
    if let TaskKind::Seam { profile } = &t.kind {
        return Some(format!("{profile}:seam"));
    }
    None
}

impl Tally {
    /// Counts one dispatch pass of `tasks` once its answers are in.
    pub(crate) fn dispatched(&mut self, tasks: &[Task]) {
        let mut sent = BTreeSet::new();
        for t in tasks {
            let Some(k) = lens_of(t) else { continue };
            if t.state == TaskState::Answered {
                self.answered.insert(k.clone());
            }
            sent.insert(k);
        }
        for k in sent {
            *self.rounds.entry(k).or_insert(0) += 1;
        }
    }
}

/// Counts a verification pass: `settled` as it judged the findings, and the run's tasks, its
/// verifiers among them.
pub(crate) fn verified(run: &mut RunState, settled: &[Value]) {
    let keyed: Vec<(String, Tier, &Value)> = settled
        .iter()
        .map(|f| {
            let lens = f.get("source").and_then(Value::as_str).unwrap_or("");
            (
                format!("{}:{lens}", finding_profile(run, f)),
                Tier::of(f),
                f,
            )
        })
        .collect();
    let verifiers: Vec<&Task> = run
        .tasks
        .iter()
        .filter(|t| {
            matches!(
                t.kind,
                TaskKind::Verify { .. } | TaskKind::VerifyBatch { .. }
            )
        })
        .collect();
    let returned = verifiers
        .iter()
        .filter(|t| t.state == TaskState::Answered || t.refused.is_some())
        .count();
    let sent = verifiers.len();
    let tally = &mut run.telemetry;
    let v = tally.verified.get_or_insert_with(Verified::default);
    v.votes_sent += sent;
    v.votes_returned += returned;
    for (key, tier, f) in keyed {
        let row = tally.lenses.entry(key).or_default();
        let discarded = f.get("votesDiscarded").and_then(Value::as_u64).unwrap_or(0) > 0;
        v.thinned += usize::from(discarded);
        match tier {
            Tier::Confirmed => {
                v.confirmed += 1;
                row.confirmed += 1;
                let sev = f.get("severity").and_then(Value::as_str).unwrap_or("");
                if SEVERITIES.contains(&sev) {
                    *row.by_severity.entry(sev.to_owned()).or_insert(0) += 1;
                }
            }
            Tier::Suspected => {
                v.suspected += 1;
                row.suspected += 1;
            }
            Tier::Refuted => {
                v.refuted += 1;
                row.refuted += 1;
            }
            Tier::Unverified => {
                v.unverified += 1;
                row.unverified += 1;
            }
        }
    }
}

/// The lenses a profile's row list names: its plan's, then each one dispatched beside them (a
/// critic's lens, the unit-mode contract lens and coordinator), each once.
fn lenses_of(run: &RunState, profile: &str) -> Vec<String> {
    let mut out: Vec<String> = run
        .plan_of(profile)
        .map(|p| p.lenses.clone())
        .unwrap_or_default();
    let prefix = format!("{profile}:");
    for k in run.telemetry.rounds.keys() {
        if let Some(lens) = k.strip_prefix(&prefix)
            && !out.iter().any(|l| l == lens)
        {
            out.push(lens.to_owned());
        }
    }
    out
}

/// Whether the lens answered: a planned one on every slice it was sent (`ranLenses`), another on
/// any dispatch.
fn ran(run: &RunState, profile: &str, lens: &str) -> bool {
    let planned = run
        .plan_of(profile)
        .filter(|p| p.lenses.iter().any(|l| l == lens));
    match planned {
        Some(plan) => run.rounds.ran(profile, plan).iter().any(|l| l == lens),
        None => run
            .telemetry
            .answered
            .contains(&format!("{profile}:{lens}")),
    }
}

/// One row per lens of each planned profile, as review's record writes `dimensions`: what it
/// found confirmed (`findingCount`, `bySeverity`), each tier's count, whether it ran, and how many
/// rounds sent it.
#[must_use]
pub fn dimensions(run: &RunState) -> Vec<Value> {
    let mut out = Vec::new();
    for track in run.tracks.iter().filter(|t| t.plan.is_some()) {
        for lens in lenses_of(run, &track.profile) {
            let key = format!("{}:{lens}", track.profile);
            let y = run.telemetry.lenses.get(&key).cloned().unwrap_or_default();
            let by: serde_json::Map<String, Value> = SEVERITIES
                .iter()
                .map(|s| {
                    (
                        (*s).to_owned(),
                        json!(y.by_severity.get(*s).copied().unwrap_or(0)),
                    )
                })
                .collect();
            let found: usize = y.by_severity.values().sum();
            out.push(json!({
                "dimension": key, "ran": ran(run, &track.profile, &lens), "verdict": "",
                "findingCount": found, "bySeverity": by,
                "confirmedCount": y.confirmed, "suspectedCount": y.suspected,
                "refutedCount": y.refuted, "unverifiedCount": y.unverified,
                "rounds": run.telemetry.rounds.get(&key).copied().unwrap_or(0),
            }));
        }
    }
    out
}

/// The run's verification as review's record writes it: the candidates verification judged (the
/// unverified left out), the confirmed, the refute rate over the candidates, the unverified and
/// the thinned; beside them each judged tier and the verifier tasks sent and answered. `null`
/// when no verification pass settled (a run ended before it).
#[must_use]
pub fn verification(run: &RunState) -> Value {
    let Some(v) = &run.telemetry.verified else {
        return Value::Null;
    };
    let candidates = v.confirmed + v.suspected + v.refuted;
    json!({
        "candidates": candidates, "confirmed": v.confirmed, "refuteRate": refute_rate(v.refuted, candidates),
        "unverified": v.unverified, "thinned": v.thinned,
        "suspected": v.suspected, "refuted": v.refuted,
        "votes": {"sent": v.votes_sent, "returned": v.votes_returned},
    })
}

/// `refuted / candidates` to two places, 0 over none (`refuteRate` in `lib/run-record.mjs`).
fn refute_rate(refuted: usize, candidates: usize) -> f64 {
    if candidates == 0 {
        return 0.0;
    }
    let hundredths = (refuted * 100 + candidates / 2) / candidates;
    f64::from(u32::try_from(hundredths).unwrap_or(100)) / 100.0
}

#[cfg(test)]
mod tests;
