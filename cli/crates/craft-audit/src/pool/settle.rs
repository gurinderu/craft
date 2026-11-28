//! Each pooled finding as its verifier judged it, or why none did.

use craft_review::settle::{finalize, tier_from_votes};
use serde_json::{Map, Value};

use super::{Pooled, verdict, verified};
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

/// Whether some verifier was handed the pooled finding `i`.
fn handed(tasks: &[Task], i: usize) -> bool {
    tasks
        .iter()
        .any(|t| matches!(&t.kind, AuditKind::Verify { findings, .. } if findings.contains(&i)))
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
    if let Some(v) = verdict(tasks, i) {
        return tier_from_votes(f, &[Some(v.clone())]);
    }
    if !handed(tasks, i) {
        return unchecked(f, "no verifier was handed it");
    }
    unchecked(
        f,
        "its verifier returned no verdict for it — a dead agent, an exhausted retry or an expired deadline",
    )
}

/// Every pooled finding settled: judged, then raised by a verified harm and capped by its harm,
/// keeping as `lensSeverity` the severity its lens rated it when that moved it.
#[must_use]
pub fn settle(pool: &[Pooled], tasks: &[Task]) -> Vec<Value> {
    pool.iter()
        .enumerate()
        .map(|(i, p)| {
            let mut f = finalize(&judged(tasks, i, &p.finding));
            let lens = p.finding.get("severity").cloned().unwrap_or(Value::Null);
            if let Some(o) = f
                .as_object_mut()
                .filter(|o| o.get("severity") != Some(&lens))
            {
                o.insert("lensSeverity".into(), lens);
            }
            f
        })
        .collect()
}
