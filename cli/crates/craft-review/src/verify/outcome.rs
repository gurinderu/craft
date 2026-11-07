//! What verification made of the pool once its votes are in, as `verifyPool` settles it: each
//! finding's panel decided, each batch read or its death named, the skipped ones said to be
//! unverified, and what did not run derived from the tiers (realm @nick/craft, node #299).

use serde_json::Value;

use super::{Route, culls, is_high, panel, returned, route_in};
use crate::settle::{self, Tier, finalize, not_verified, tier_from_votes};
use crate::state::{RunState, Task, TaskKind, TaskState};

/// The note a skipped finding carries, as `routedUnverified` words it.
fn skipped(f: &Value, light: bool) -> Value {
    let sev = f.get("severity").and_then(Value::as_str);
    let why = if light {
        format!(
            "light pass: only Medium and above are verified, so no verifier was spent on this {} finding and nothing here has been checked against the code",
            sev.filter(|s| !s.is_empty()).unwrap_or("unrated")
        )
    } else {
        format!(
            "no verifier was spent on it — {} cannot change the verdict either way, so nothing here has been checked against the code",
            sev.unwrap_or("undefined")
        )
    };
    not_verified(f, &why)
}

/// A Critical or High panel opens with the deciding pair and is settled on it when the two agree;
/// otherwise on every vote that came back. Any other finding routed alone has one vote.
fn individual(run: &RunState, i: usize, f: &Value) -> Value {
    let votes = panel(run, i);
    let n1 = culls(run);
    let opening: Vec<Option<Value>> = votes
        .iter()
        .filter(|(k, _)| *k == 0 || (is_high(f) && *k == n1))
        .map(|(_, v)| v.clone())
        .collect();
    let live: Vec<&Value> = opening.iter().flatten().collect();
    if matches!(live.as_slice(), [a, b] if settle::agree(a, b)) {
        return tier_from_votes(f, &opening);
    }
    let all: Vec<Option<Value>> = votes.into_iter().map(|(_, v)| v).collect();
    tier_from_votes(f, &all)
}

/// Why a batch's answer judged nothing (`batchDeath`), or `None` when it carries verdicts.
fn batch_death(answer: Option<&Value>) -> Option<&'static str> {
    let Some(a) = answer else {
        return Some(
            "returned nothing at all — a dead agent, an exhausted retry, or an expired deadline",
        );
    };
    match a.get("verdicts").and_then(Value::as_array) {
        None => Some("answered OFF-SCHEMA — its answer carried no verdict list at all"),
        Some(v) if v.is_empty() => Some("answered with an EMPTY verdict list — it judged nothing"),
        Some(_) => None,
    }
}

/// A finding a live batch verifier left out of its verdicts: it was part of an inspection, so it
/// stays Suspected.
fn lost(f: &Value) -> Value {
    let why = f.get("why").and_then(Value::as_str).unwrap_or("");
    let mut g = f.clone();
    if let Some(o) = g.as_object_mut() {
        o.insert("tier".into(), "suspected".into());
        o.insert(
            "why".into(),
            format!("{why} (batch verifier returned no verdict for this finding)").into(),
        );
    }
    g
}

/// The findings of one batch as its verifier's answer judged them.
fn batch(run: &RunState, task: &Task, group: &[usize]) -> Vec<(usize, Value)> {
    let answer = returned(task);
    let death = batch_death(answer.as_ref());
    let file = group
        .first()
        .and_then(|&i| run.findings.get(i))
        .and_then(|f| f.get("file"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("?");
    let verdicts = answer
        .as_ref()
        .and_then(|a| a.get("verdicts"))
        .and_then(Value::as_array);
    group
        .iter()
        .enumerate()
        .filter_map(|(at, &i)| Some((at, i, run.findings.get(i)?)))
        .map(|(at, i, f)| {
            let judged = match death {
                Some(why) => not_verified(
                    f,
                    &format!(
                        "the batch verifier for {file} {why}, so nothing checked this finding against the code"
                    ),
                ),
                None => match verdicts.into_iter().flatten().find(|v| {
                    v.get("index").and_then(Value::as_u64) == u64::try_from(at).ok()
                }) {
                    Some(v) => tier_from_votes(f, &[Some(v.clone())]),
                    None => lost(f),
                },
            };
            (i, judged)
        })
        .collect()
}

/// The first reason a returned vote on `i` gave, for the report.
fn reason(run: &RunState, i: usize) -> Option<Value> {
    panel(run, i)
        .into_iter()
        .filter_map(|(_, v)| v)
        .filter(settle::shaped)
        .find_map(|v| v.get("reason").cloned())
}

/// Settles the pool into `run.settled`, notes each verifier that gave no valid answer, and adds
/// what did not run to `run.not_run`.
pub(crate) fn settle_run(run: &mut RunState, profile: &str) {
    let mut out: Vec<Option<Value>> = vec![None; run.findings.len()];
    for (i, f) in run.findings.iter().enumerate() {
        let one = match route_in(f, run.light) {
            Route::Skip => skipped(f, run.light),
            Route::Batch => continue,
            Route::Individual => {
                let mut v = individual(run, i, f);
                if let (Some(r), Some(o)) = (reason(run, i), v.as_object_mut()) {
                    o.insert("verifierReason".into(), r);
                }
                v
            }
        };
        if let Some(slot) = out.get_mut(i) {
            *slot = Some(one);
        }
    }
    for task in &run.tasks {
        if let TaskKind::VerifyBatch { findings } = &task.kind {
            for (i, v) in batch(run, task, findings) {
                if let Some(slot) = out.get_mut(i) {
                    *slot = Some(v);
                }
            }
        }
    }
    let failed: Vec<String> = run
        .tasks
        .iter()
        .filter(|t| t.state == TaskState::Failed)
        .map(|t| {
            let why = t.error.clone().unwrap_or_default();
            format!("{} gave no valid answer: {why}", t.label)
        })
        .collect();
    run.notes.extend(failed);
    let settled: Vec<Value> = out.into_iter().flatten().map(|f| finalize(&f)).collect();
    let gaps = not_run(run, &settled, profile);
    for g in gaps {
        if !run.not_run.contains(&g) {
            run.not_run.push(g);
        }
    }
    run.settled = settled;
}

/// What verification did not do, derived from the tiers as `verifyPool`'s `notRun`: findings a
/// verifier was routed to and none judged, and refutations a thinned panel made.
fn not_run(run: &RunState, settled: &[Value], profile: &str) -> Vec<String> {
    let file = |f: &Value| {
        f.get("file")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("?")
            .to_owned()
    };
    let discarded = |f: &Value| f.get("votesDiscarded").and_then(Value::as_u64).unwrap_or(0) > 0;
    let routed = settled
        .iter()
        .zip(&run.findings)
        .filter(|(_, orig)| route_in(orig, run.light) != Route::Skip)
        .map(|(f, _)| f);
    let deaths: Vec<&Value> = routed
        .clone()
        .filter(|f| Tier::of(f) == Tier::Unverified)
        .collect();
    let mut out = Vec::new();
    for f in deaths.iter().filter(|f| !discarded(f)) {
        out.push(format!("{profile} verification of {} — the verifier(s) died before returning a verdict, so those finding(s) were never checked against the code", file(f)));
    }
    for f in deaths.iter().filter(|f| discarded(f)) {
        out.push(format!("{profile} verification of {} — every returned vote answered OFF-SCHEMA and was discarded before the arithmetic, so those finding(s) were never checked against the code", file(f)));
    }
    for f in routed.filter(|f| Tier::of(f) == Tier::Refuted && discarded(f)) {
        out.push(format!("{profile} verification of {} — a finding was REFUTED and deleted from the run by a THINNED PANEL (at least one returned vote answered off-schema and was discarded), so the deletion rests on partial evidence", file(f)));
    }
    let mut seen = Vec::new();
    out.retain(|s| {
        let new = !seen.contains(s);
        if new {
            seen.push(s.clone());
        }
        new
    });
    out
}
