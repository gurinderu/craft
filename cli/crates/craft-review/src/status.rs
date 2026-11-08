//! `status`: where a run stands, read by the host and, later, by a progress view.

use std::path::Path;

use serde_json::{Value, json};

use crate::report;
use crate::state::{self, Phase, RunState, StateError};

/// The phase as a reader names it: `scout`, `lenses round N`, `dedup`, `verify` or `done`.
fn phase_label(run: &RunState) -> String {
    match run.phase {
        Phase::Scout => "scout".into(),
        Phase::RedTeam => "red team".into(),
        Phase::Match => "memory match judge".into(),
        Phase::Rules => "project rule judge".into(),
        Phase::Lenses => format!("lenses round {}", run.rounds.round),
        Phase::Dedup => "dedup".into(),
        Phase::Verify => "verify".into(),
        Phase::Critic => "completeness critic".into(),
        Phase::CriticLenses => "critic follow-up lenses".into(),
        Phase::Done => "done".into(),
    }
}

/// Where the run in `dir` stands: its phase, each profile's files and plan, the rounds, the counts
/// and every task's state.
///
/// # Errors
/// When the state cannot be read.
pub fn status(dir: &Path) -> Result<Value, StateError> {
    let run = state::load(dir)?;
    let [confirmed, suspected, refuted, unverified] = report::tier_counts(&run);
    let tasks: Vec<Value> = run
        .tasks
        .iter()
        .map(|t| {
            json!({"id": t.id, "label": t.label, "state": t.state, "retries": t.retries, "error": t.error})
        })
        .collect();
    let profiles: Vec<Value> = run
        .tracks
        .iter()
        .map(|t| {
            let plan = t.plan.as_ref().map(|p| {
                json!({"sizeBucket": p.size_bucket, "lenses": p.lenses, "maxRounds": p.max_rounds, "light": run.light,
                       "ran": run.rounds.ran(&t.profile, p), "surfaceDropped": p.surface_dropped, "lightSkipped": p.light_skipped})
            });
            json!({"profile": t.profile, "files": t.files.len(), "rounds": t.rounds, "dry": t.dry, "plan": plan})
        })
        .collect();
    let mut s = json!({
        "run": dir.display().to_string(), "phase": phase_label(&run), "round": run.rounds.round,
        "done": run.phase == Phase::Done,
        "base": run.diff.base, "mergeBase": run.diff.merge_base, "head": run.diff.head, "dirty": run.diff.dirty,
        "files": run.diff.files.len(), "profiles": profiles, "rounds": run.rounds.yields, "pool": run.rounds.pool.len(),
        "findings": run.findings.len(),
        "tiers": {"confirmed": confirmed, "suspected": suspected, "refuted": refuted, "unverified": unverified},
        "tasks": tasks, "notRun": run.not_run, "notes": run.notes,
        "round": run.chain.round.max(1), "priors": run.chain.priors.len(),
    });
    if let (Some(v), Some(obj)) = (&run.verdict, s.as_object_mut()) {
        obj.insert("verdict".into(), json!(v));
        obj.insert(
            "report".into(),
            json!(state::report_path(dir).display().to_string()),
        );
    }
    Ok(s)
}
