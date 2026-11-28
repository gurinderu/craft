//! The audit's findings: pooled from its answered lens tasks in their order, so a later pass's
//! findings join after the earlier ones' and a verifier's indices stay put; only those at Medium
//! and above are verified, as the light review verifies (realm @nick/craft, node #636) — Critical
//! and High each alone, Medium in batches of one profile —; each settled by its verifier's vote
//! ([`craft_review::settle::tier_from_votes`]) and finalized by its harm, the only ground of its
//! severity with no changed lines ([`craft_review::settle::finalize`]).

use craft_step::TaskState;
use serde_json::{Map, Value};

use crate::kind::AuditKind;
use crate::state::Task;

mod settle;

pub use settle::settle;

/// How many Medium findings one verifier judges, as the review batches them.
pub const BATCH_SIZE: usize = 6;

/// A pooled finding and the profile whose lens raised it.
#[derive(Debug, Clone, PartialEq)]
pub struct Pooled {
    pub profile: String,
    pub finding: Value,
}

/// The findings of every answered lens task, in task order, each naming its lens as its source
/// when it names none.
#[must_use]
pub fn pool(tasks: &[Task]) -> Vec<Pooled> {
    let mut out = Vec::new();
    for t in tasks.iter().filter(|t| t.state == TaskState::Answered) {
        let AuditKind::Lens { profile, lens, .. } = &t.kind else {
            continue;
        };
        let found = t.answer.as_ref().and_then(|a| a.get("findings"));
        for f in found.and_then(Value::as_array).into_iter().flatten() {
            let mut o: Map<String, Value> = f.as_object().cloned().unwrap_or_default();
            if o.get("source")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            {
                o.insert("source".into(), Value::String(lens.clone()));
            }
            out.push(Pooled {
                profile: profile.clone(),
                finding: Value::Object(o),
            });
        }
    }
    out
}

fn severity(f: &Value) -> &str {
    f.get("severity").and_then(Value::as_str).unwrap_or("")
}

/// Whether a verifier judges `f`: at Medium and above.
#[must_use]
pub fn verified(f: &Value) -> bool {
    matches!(severity(f), "Critical" | "High" | "Medium")
}

/// Whether the pooled finding `i` is in the batch of a verifier that has not failed: one whose
/// verifier died is handed to a new one by the next pass.
fn routed(tasks: &[Task], i: usize) -> bool {
    tasks.iter().any(|t| {
        t.state != TaskState::Failed
            && matches!(&t.kind, AuditKind::Verify { findings, .. } if findings.contains(&i))
    })
}

/// The verifier batches the findings no live verifier holds need, each with its profile: a
/// Critical or High finding alone, Medium ones of a profile up to [`BATCH_SIZE`] together.
#[must_use]
pub fn batches(pool: &[Pooled], tasks: &[Task]) -> Vec<(String, Vec<usize>)> {
    let mut out: Vec<(String, Vec<usize>)> = Vec::new();
    let mut medium: Vec<(String, Vec<usize>)> = Vec::new();
    for (i, p) in pool.iter().enumerate() {
        if !verified(&p.finding) || routed(tasks, i) {
            continue;
        }
        if severity(&p.finding) != "Medium" {
            out.push((p.profile.clone(), vec![i]));
            continue;
        }
        match medium
            .iter_mut()
            .find(|(profile, group)| *profile == p.profile && group.len() < BATCH_SIZE)
        {
            Some((_, group)) => group.push(i),
            None => medium.push((p.profile.clone(), vec![i])),
        }
    }
    out.extend(medium);
    out
}

#[cfg(test)]
mod tests;
