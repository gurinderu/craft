//! The waves of verification, as `verifyPool` buys them: per finding routed alone, one cull vote,
//! and for a Critical or High the deciding pair — that cull plus one authoritative vote on the lens
//! model — with the rest of its panel bought only when the pair does not agree; per batch of the
//! batched, one vote.

use serde_json::Value;

use super::{BATCH_SIZE, Route, route_in};
use crate::agent::Model;
use crate::content::{self, ContentError};
use crate::profile::Profile;
use crate::prompts;
use crate::settle;
use crate::state::{RunState, Task, TaskKind, TaskState, finding_profile};

/// The cheap model of the cull votes and the batches, as `CULL_MODEL`.
const CULL_MODEL: Model = Model::Sonnet;
/// The model of a Critical or High panel's one authoritative vote: the plan's `lensModel`, a
/// constant in `lib/review-plan.mjs`.
const AUTH_MODEL: Model = Model::Opus;

/// Whether `f` gets the authoritative vote and may escalate: a Critical or High.
pub(super) fn is_high(f: &Value) -> bool {
    matches!(
        f.get("severity").and_then(Value::as_str),
        Some("Critical" | "High")
    )
}

/// The cull votes a High or Critical panel on `f` holds at most, `max(1, plan.verifyVotes)` of the
/// plan of `f`'s profile; the authoritative vote is the one after them.
pub(super) fn culls(run: &RunState, f: &Value) -> u32 {
    run.plan_of(finding_profile(run, f))
        .map_or(1, |p| p.verify_votes)
        .max(1)
}

/// The profile `f` was found under, whose rubric its verifiers read.
fn profile_of(run: &RunState, f: &Value) -> Result<Profile, ContentError> {
    Profile::load(finding_profile(run, f))
}

/// The first wave of verification, as `verifyPool` dispatches it: per finding routed alone, one
/// cull vote, and for a Critical or High the deciding pair — that cull plus one authoritative vote
/// on the lens model; per batch of the batched (grouped by profile and file, at most `BATCH_SIZE`),
/// one vote.
pub(crate) fn tasks(run: &RunState) -> Result<Vec<Task>, ContentError> {
    let mut tasks = Vec::new();
    let mut rest = Vec::new();
    for (i, f) in run.findings.iter().enumerate() {
        match route_in(f, run.light) {
            Route::Individual => {
                tasks.push(vote(run, i, f, 0)?);
                if is_high(f) {
                    tasks.push(vote(run, i, f, culls(run, f))?);
                }
            }
            Route::Batch => rest.push(i),
            Route::Skip => {}
        }
    }
    for (k, group) in by_file(run, &rest).iter().enumerate() {
        let findings: Vec<&Value> = group.iter().filter_map(|&i| run.findings.get(i)).collect();
        let Some(first) = findings.first() else {
            continue;
        };
        let file = first.get("file").and_then(Value::as_str);
        tasks.push(Task::new(
            format!("verify-batch-{k}"),
            format!("verify-batch:{}({})", file.unwrap_or("?"), group.len()),
            prompts::batch_verify_prompt(&run.context, &profile_of(run, first)?, &findings)?,
            CULL_MODEL,
            content::schema("batch-verdict")?,
            TaskKind::VerifyBatch {
                findings: group.clone(),
            },
        ));
    }
    Ok(tasks)
}

/// The batched findings grouped by profile and file in the order they first appear, each group cut
/// to `BATCH_SIZE`, so one verifier reads one file's context once under one rubric.
fn by_file(run: &RunState, batched: &[usize]) -> Vec<Vec<usize>> {
    let mut files: Vec<((&str, &str), Vec<usize>)> = Vec::new();
    for &i in batched {
        let Some(f) = run.findings.get(i) else {
            continue;
        };
        let file = f
            .get("file")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("?");
        let file = (finding_profile(run, f), file);
        match files.iter_mut().find(|(f, _)| *f == file) {
            Some((_, list)) => list.push(i),
            None => files.push((file, vec![i])),
        }
    }
    files
        .iter()
        .flat_map(|(_, list)| list.chunks(BATCH_SIZE).map(<[usize]>::to_vec))
        .collect()
}

/// The second wave: the remaining cull votes of each Critical or High panel whose deciding pair did
/// not come back as two agreeing judgements, as `verifyPool` buys them; none once bought.
pub(crate) fn escalation(run: &RunState) -> Result<Vec<Task>, ContentError> {
    let mut tasks = Vec::new();
    for (i, f) in run.findings.iter().enumerate() {
        let n1 = culls(run, f);
        if route_in(f, run.light) != Route::Individual || !is_high(f) || n1 < 2 {
            continue;
        }
        let votes = panel(run, i);
        let bought = votes.iter().any(|(k, _)| (1..n1).contains(k));
        let pair: Vec<&Value> = votes.iter().filter_map(|(_, v)| v.as_ref()).collect();
        let settled = matches!(pair.as_slice(), [a, b] if settle::agree(a, b));
        if bought || settled {
            continue;
        }
        for k in 1..n1 {
            tasks.push(vote(run, i, f, k)?);
        }
    }
    Ok(tasks)
}

/// Vote `k` on finding `i`: a cull vote on the cheap model below `culls`, the authoritative one on
/// the lens model at it.
fn vote(run: &RunState, i: usize, f: &Value, k: u32) -> Result<Task, ContentError> {
    let file = f.get("file").and_then(Value::as_str).unwrap_or("?");
    let line = f.get("line").and_then(Value::as_i64).unwrap_or(0);
    let auth = is_high(f) && k == culls(run, f);
    let (tag, model) = if auth {
        ("auth".to_owned(), AUTH_MODEL)
    } else {
        (format!("c{}", k + 1), CULL_MODEL)
    };
    Ok(Task::new(
        format!("verify-{i}-v{k}"),
        format!("verify:{file}:{line}#{tag}"),
        prompts::verify_prompt(&run.context, &profile_of(run, f)?, f, k)?,
        model,
        content::schema("verdict")?,
        TaskKind::Verify {
            finding: i,
            voter: k,
        },
    ))
}

/// The votes on finding `i` so far, by voter: the valid answer, the refused one (an off-schema
/// vote), or `None` for a voter that returned nothing.
pub(crate) fn panel(run: &RunState, i: usize) -> Vec<(u32, Option<Value>)> {
    run.tasks
        .iter()
        .filter_map(|t| match t.kind {
            TaskKind::Verify { finding, voter } if finding == i => Some((voter, returned(t))),
            TaskKind::Verify { .. }
            | TaskKind::VerifyBatch { .. }
            | TaskKind::Scout { .. }
            | TaskKind::Lens { .. }
            | TaskKind::Dedup => None,
        })
        .collect()
}

/// What a task's agent returned: its valid answer, or the last answer refused when it ran out of
/// retries; `None` when it returned nothing.
pub(crate) fn returned(t: &Task) -> Option<Value> {
    match t.state {
        TaskState::Answered => t.answer.clone(),
        TaskState::Failed => t.refused.clone(),
        TaskState::Pending => None,
    }
}
