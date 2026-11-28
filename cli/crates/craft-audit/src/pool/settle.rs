//! Each pooled finding as its verifier judged it, or why none did.

use craft_review::settle::{finalize, tier_from_votes};
use craft_step::TaskState;
use serde_json::{Map, Value};

use super::{Pooled, verified};
use crate::kind::AuditKind;
use crate::state::Task;

/// `f` that nothing checked against the code, and why, as the review marks it.
fn unchecked(f: &Value, why: &str) -> Value {
    marked(f, "unverified", &format!("NOT VERIFIED: {why}"))
}

fn marked(f: &Value, tier: &str, note: &str) -> Value {
    let mut o: Map<String, Value> = f.as_object().cloned().unwrap_or_default();
    let why = o
        .get("why")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    o.insert("tier".into(), Value::String(tier.into()));
    o.insert("why".into(), Value::String(format!("{why} ({note})")));
    Value::Object(o)
}

/// The latest verifier task holding the pooled finding `i`, and its place in that task's batch.
fn holder(tasks: &[Task], i: usize) -> Option<(&Task, usize)> {
    tasks.iter().rev().find_map(|t| match &t.kind {
        AuditKind::Verify { findings, .. } => {
            findings.iter().position(|&j| j == i).map(|at| (t, at))
        }
        AuditKind::Lens { .. } => None,
    })
}

/// The finding `f`, pooled at `i`, as its verifier judged it.
fn judged(tasks: &[Task], i: usize, f: &Value) -> Value {
    if !verified(f) {
        let sev = f
            .get("severity")
            .and_then(Value::as_str)
            .unwrap_or("unrated");
        return unchecked(
            f,
            &format!(
                "an audit verifies only Medium and above, so no verifier was spent on this {sev} finding"
            ),
        );
    }
    let Some((task, at)) = holder(tasks, i) else {
        return unchecked(f, "no verifier was handed it");
    };
    let verdicts = task
        .answer
        .as_ref()
        .filter(|_| task.state == TaskState::Answered)
        .and_then(|a| a.get("verdicts"))
        .and_then(Value::as_array)
        .filter(|v| !v.is_empty());
    let Some(verdicts) = verdicts else {
        return unchecked(
            f,
            "its verifier returned no verdicts — a dead agent, an exhausted retry or an expired deadline",
        );
    };
    let at = u64::try_from(at).ok();
    match verdicts
        .iter()
        .find(|v| v.get("index").and_then(Value::as_u64) == at)
    {
        Some(v) => tier_from_votes(f, &[Some(v.clone())]),
        None => marked(
            f,
            "suspected",
            "its verifier returned no verdict for this finding",
        ),
    }
}

/// Every pooled finding settled: judged, then raised by a verified harm and capped by its harm.
#[must_use]
pub fn settle(pool: &[Pooled], tasks: &[Task]) -> Vec<Value> {
    pool.iter()
        .enumerate()
        .map(|(i, p)| finalize(&judged(tasks, i, &p.finding)))
        .collect()
}
