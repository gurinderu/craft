//! What a run stopped before verification settled its pool reports (realm @nick/craft, node #299):
//! every finding it has, as it stood — a panel that came back whole as its votes decide it,
//! one cut short Suspected on the votes it has, one no verifier judged yet unverified — so the
//! report and the verdict never read as no findings while the run holds some. A stop in the
//! completeness critic's own pass keeps the first pass's settled findings beside the critic's.

use serde_json::Value;

use super::outcome::judged;
use super::{Route, awaits_escalation, panel, route_in};
use crate::critic::Stage;
use crate::settle::{self, finalize_in, not_verified};
use crate::state::{Phase, RunState, TaskKind, TaskState};

/// Why a finding a stop cut off carries no tier of its panel.
const STOPPED: &str = "the run stopped before verification finished";

/// Fills `run.settled` of a run stopped before verification settled it, from the pool it has —
/// the dedup's, or the lens rounds' when the run stopped before the dedup — after the first pass's
/// settled findings when the critic's pass stopped, and notes it.
pub(crate) fn stood(run: &mut RunState) {
    if !run.settled.is_empty() {
        return;
    }
    let settled: Vec<Value> = if run.phase == Phase::Verify {
        let judged = judged(run);
        let at = |(i, f): (usize, &Value)| match judged.get(i).cloned().flatten() {
            Some(v) if !open(run, i, f) => v,
            _ => partial(run, i, f),
        };
        run.findings.iter().enumerate().map(at).collect()
    } else {
        let pool = if run.findings.is_empty() {
            &run.rounds.pool
        } else {
            &run.findings
        };
        let why = format!(
            "{STOPPED}: no verifier had judged it yet, so nothing here has been checked against the code"
        );
        pool.iter().map(|f| not_verified(f, &why)).collect()
    };
    if settled.is_empty() {
        return;
    }
    run.notes.push(note(run.phase, settled.len()));
    let mut all = if run.critic.stage == Stage::Verifying {
        run.critic.settled_before.clone()
    } else {
        Vec::new()
    };
    all.extend(settled.iter().map(|f| finalize_in(f, run.context.strict)));
    run.settled = all;
}

/// The note on the `n` findings a stop in `phase` left as they stood: the lens rounds cut short
/// before verification began, or verification cut short.
fn note(phase: Phase, n: usize) -> String {
    if matches!(phase, Phase::Dedup | Phase::Verify) {
        format!(
            "verification stopped before it finished: {n} finding(s) are reported as they stood — a finding whose verifiers had not all answered is Suspected on the votes it has or unverified without any; the resume settles them"
        )
    } else {
        format!(
            "the lens rounds stopped before verification began: {n} finding(s) found so far are reported unverified; the resume finishes the rounds and verifies them"
        )
    }
}

/// Whether finding `i` still waits on a verifier: a vote or its batch not answered or not yet
/// handed out, or the rest of its panel still to buy.
fn open(run: &RunState, i: usize, f: &Value) -> bool {
    let mine = |t: &&crate::state::Task| {
        matches!(&t.kind, TaskKind::Verify { finding, .. } if *finding == i)
            || matches!(&t.kind, TaskKind::VerifyBatch { findings } if findings.contains(&i))
    };
    let states: Vec<TaskState> = run.tasks.iter().filter(mine).map(|t| t.state).collect();
    match route_in(f, run.light) {
        Route::Skip => false,
        Route::Individual | Route::Batch => {
            states.is_empty()
                || states.contains(&TaskState::Pending)
                || awaits_escalation(run, i, f)
        }
    }
}

/// Finding `i` as its cut-short panel leaves it: Suspected on the votes that came in, unverified
/// with none — a panel that did not finish neither confirms nor refutes it.
fn partial(run: &RunState, i: usize, f: &Value) -> Value {
    let votes: Vec<Value> = panel(run, i)
        .into_iter()
        .filter_map(|(_, v)| v)
        .filter(settle::shaped)
        .collect();
    if votes.is_empty() {
        return not_verified(
            f,
            &format!(
                "{STOPPED}: no verifier had judged it yet, so nothing here has been checked against the code"
            ),
        );
    }
    let refuting = votes
        .iter()
        .filter(|v| v.get("refuted").and_then(Value::as_bool) == Some(true))
        .count();
    let why = f.get("why").and_then(Value::as_str).unwrap_or("");
    let mut g = f.clone();
    if let Some(o) = g.as_object_mut() {
        o.insert("tier".into(), "suspected".into());
        o.insert(
            "why".into(),
            format!(
                "{why} ({STOPPED}: {} of its verifier votes came in, {refuting} refuting — Suspected until its panel finishes)",
                votes.len()
            )
            .into(),
        );
    }
    g
}
