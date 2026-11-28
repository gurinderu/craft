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

/// The verdict a verifier gave the pooled finding `i`: the latest answered verifier holding it,
/// at its place in that verifier's batch. An answer missing it judged nothing of it.
#[must_use]
pub fn verdict(tasks: &[Task], i: usize) -> Option<&Value> {
    tasks.iter().rev().find_map(|t| {
        let AuditKind::Verify { findings, .. } = &t.kind else {
            return None;
        };
        let at = u64::try_from(findings.iter().position(|&j| j == i)?).ok()?;
        let answer = t
            .answer
            .as_ref()
            .filter(|_| t.state == TaskState::Answered)?;
        answer
            .get("verdicts")?
            .as_array()?
            .iter()
            .find(|v| v.get("index").and_then(Value::as_u64) == Some(at))
    })
}

/// The pooled findings a verifier must judge — at Medium and above as their lens rated them, the
/// severity that routes them, before their harm caps it — that no verifier gave a verdict: none
/// was handed them yet, or theirs died. The report, the finished step and the resume read this one
/// list.
#[must_use]
pub fn unjudged(pool: &[Pooled], tasks: &[Task]) -> Vec<usize> {
    pool.iter()
        .enumerate()
        .filter(|(i, p)| verified(&p.finding) && verdict(tasks, *i).is_none())
        .map(|(i, _)| i)
        .collect()
}

/// Whether a verifier still pending holds the pooled finding `i`.
fn pending(tasks: &[Task], i: usize) -> bool {
    tasks.iter().any(|t| {
        t.state == TaskState::Pending
            && matches!(&t.kind, AuditKind::Verify { findings, .. } if findings.contains(&i))
    })
}

/// The verifier batches the unjudged findings ([`unjudged`]) no pending verifier holds need, each
/// with its profile: a Critical or High finding alone, Medium ones of a profile up to
/// [`BATCH_SIZE`] together.
#[must_use]
pub fn batches(pool: &[Pooled], tasks: &[Task]) -> Vec<(String, Vec<usize>)> {
    let mut out: Vec<(String, Vec<usize>)> = Vec::new();
    let mut medium: Vec<(String, Vec<usize>)> = Vec::new();
    let unjudged = unjudged(pool, tasks);
    for (i, p) in pool.iter().enumerate() {
        if !unjudged.contains(&i) || pending(tasks, i) {
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
