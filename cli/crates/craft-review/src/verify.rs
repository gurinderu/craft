//! The verification phase: which verifier judges which finding, and what their verdicts say about each.

use anyhow::Result;
use serde_json::Value;

use crate::content;
use crate::prompts;
use crate::state::{RunState, Task, TaskKind, TaskState};

const VERIFY_MODEL: &str = "sonnet";
/// How many findings one batch verifier judges, as `BATCH_SIZE` in `lib/review-verify.mjs`.
pub(crate) const BATCH_SIZE: usize = 6;
/// Rules that block on sight: a finding citing one is verified on its own whatever its severity.
pub(crate) const CRITICAL_TIER_RULES: &[&str] = &[
    "SAF-001", "SAF-002", "SAF-003", "SAF-004", "SAF-005", "SAF-006", "SAF-008", "ERR-001",
    "ERR-002",
];

/// How a finding is verified, as `verifyTier` in `lib/review-verify.mjs` routes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Route {
    /// A verifier of its own: Critical or High, or citing a rule that blocks on sight.
    Individual,
    /// One verifier judges a batch of them: Medium.
    Batch,
    /// No verifier: a Low or Info citing no rule that blocks on sight cannot move the verdict, so
    /// it stays unverified.
    Skip,
}

impl Route {
    /// The route as the engines name it.
    #[cfg(test)]
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Individual => "individual",
            Self::Batch => "batch",
            Self::Skip => "skip",
        }
    }
}

/// The route `f` takes: Critical and High alone, Medium batched, Low and Info skipped unless they
/// cite a rule that blocks on sight.
pub(crate) fn route(f: &Value) -> Route {
    let sev = f.get("severity").and_then(Value::as_str).unwrap_or("");
    let rule = f.get("ruleId").and_then(Value::as_str).unwrap_or("");
    match sev {
        "Critical" | "High" => Route::Individual,
        "Medium" => Route::Batch,
        _ if CRITICAL_TIER_RULES.contains(&rule) => Route::Individual,
        _ => Route::Skip,
    }
}

/// One verifier per finding routed alone, one per batch of the batched; none for the skipped.
pub(crate) fn tasks(run: &RunState) -> Result<Vec<Task>> {
    let mut tasks = Vec::new();
    let mut rest = Vec::new();
    for (i, f) in run.findings.iter().enumerate() {
        match route(f) {
            Route::Individual => tasks.push(individual(run, i, f)?),
            Route::Batch => rest.push(i),
            Route::Skip => {}
        }
    }
    for (k, group) in rest.chunks(BATCH_SIZE).enumerate() {
        let findings: Vec<&Value> = group.iter().filter_map(|&i| run.findings.get(i)).collect();
        let first = findings
            .first()
            .and_then(|f| f.get("file"))
            .and_then(Value::as_str);
        tasks.push(Task::new(
            format!("verify-batch-{k}"),
            format!("verify-batch:{}({})", first.unwrap_or("?"), group.len()),
            prompts::batch_verify_prompt(&run.context, &findings)?,
            VERIFY_MODEL,
            content::schema("batch-verdict")?,
            TaskKind::VerifyBatch {
                findings: group.to_vec(),
            },
        ));
    }
    Ok(tasks)
}

/// The verifier of finding `i` alone.
fn individual(run: &RunState, i: usize, f: &Value) -> Result<Task> {
    let file = f.get("file").and_then(Value::as_str).unwrap_or("?");
    let line = f.get("line").and_then(Value::as_i64).unwrap_or(0);
    Ok(Task::new(
        format!("verify-{i}"),
        format!("verify:{file}:{line}"),
        prompts::verify_prompt(&run.context, f)?,
        VERIFY_MODEL,
        content::schema("verdict")?,
        TaskKind::Verify { finding: i },
    ))
}

/// The note a run carries when some findings were routed past verification, as the engine's log
/// says it.
pub(crate) fn skipped_note(run: &RunState) -> Option<String> {
    let n = run
        .findings
        .iter()
        .filter(|f| route(f) == Route::Skip)
        .count();
    (n > 0).then(|| {
        format!(
            "{n} Low/Info finding(s) NOT VERIFIED: no verifier was spent on them, since Low and Info cannot change the verdict either way; they are reported as unverified"
        )
    })
}

/// Each answered verifier's verdict onto its finding; a failed one leaves its findings unverified.
pub(crate) fn collect_votes(run: &mut RunState) {
    for task in &run.tasks {
        let Some(answer) = task
            .answer
            .as_ref()
            .filter(|_| task.state == TaskState::Answered)
        else {
            let why = task.error.clone().unwrap_or_default();
            run.notes
                .push(format!("{} gave no valid answer: {why}", task.label));
            continue;
        };
        match &task.kind {
            TaskKind::Verify { finding } => {
                if let Some(slot) = run.votes.get_mut(*finding) {
                    *slot = Some(answer.clone());
                }
            }
            TaskKind::VerifyBatch { findings } => {
                let verdicts = answer.get("verdicts").and_then(Value::as_array);
                for v in verdicts.into_iter().flatten() {
                    let at = v
                        .get("index")
                        .and_then(Value::as_u64)
                        .and_then(|i| usize::try_from(i).ok());
                    let finding = at.and_then(|i| findings.get(i));
                    if let Some(slot) = finding.and_then(|&f| run.votes.get_mut(f)) {
                        *slot = Some(v.clone());
                    }
                }
            }
            TaskKind::Lens => {}
        }
    }
}
