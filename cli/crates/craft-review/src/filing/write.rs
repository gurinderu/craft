//! The two writes and what each answer does to the run's telemetry. A write that does not land is
//! one line of `lost`, `<what> — <why>`, as the driver's notes word it.

use std::path::Path;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::wire::{
    Call, CheckpointAsked, CheckpointDone, Common, RecordAsked, RecordDone, WriteError, Writer,
};
use super::{Filing, Record, Told};

fn send(
    run: &Path,
    filing: &Filing,
    command: &str,
    request: &Value,
    w: &dyn Writer,
) -> Result<Value, WriteError> {
    let root = filing
        .ctx
        .root
        .as_deref()
        .filter(|r| !r.is_empty())
        .ok_or(WriteError::NoRoot)?;
    w.write(&Call {
        run,
        root,
        repo: &filing.ctx.repo,
        command,
        request,
    })
}

/// `asked` sent as `command`, its answer read as `D`; an answer of another shape is the writer's
/// failure.
fn exchange<A: Serialize, D: DeserializeOwned>(
    run: &Path,
    filing: &Filing,
    command: &str,
    asked: &A,
    w: &dyn Writer,
) -> Result<D, WriteError> {
    let request = serde_json::to_value(asked).map_err(|e| WriteError::Broken(e.to_string()))?;
    let answer = send(run, filing, command, &request, w)?;
    serde_json::from_value(answer).map_err(|e| WriteError::NoAnswer(e.to_string()))
}

/// The start's checkpoint, or the one of the phase the last step ended — which the adapter decides
/// by replaying the driver's clock, answering `skipped` when none ended: the directory it landed in
/// kept for the next write, a failure said.
pub(super) fn checkpoint(
    run: &Path,
    filing: &mut Filing,
    start: bool,
    lost: &mut Vec<String>,
    w: &dyn Writer,
) {
    let armed = filing.run_dir.is_empty() && filing.failed;
    let asked = CheckpointAsked {
        common: Common::of(filing, armed),
        start,
    };
    let done = exchange::<_, CheckpointDone>(run, filing, "checkpoint", &asked, w);
    // Unreached, the writer could not say whether a phase ended: only a step that may have ended
    // one can have lost its checkpoint.
    let maybe = ended_maybe(&filing.steps);
    if matches!(&done, Ok(d) if d.skipped) || (done.is_err() && !start && maybe.is_none()) {
        return;
    }
    filing.rejoin |= armed;
    let (phase, why) = match done {
        Ok(d) if !d.run_dir.is_empty() => {
            filing.run_dir = d.run_dir;
            return;
        }
        Ok(d) if !d.error.is_empty() => (d.phase, d.error),
        Ok(d) => (d.phase, "the writer named no run directory".to_owned()),
        Err(e) => (maybe.unwrap_or_default(), e.to_string()),
    };
    filing.failed = true;
    let what = match (start, phase.as_str()) {
        (true, _) => "phase checkpoint 'start'".to_owned(),
        (false, "") => "the checkpoint of the phase that ended".to_owned(),
        (false, p) => format!("phase checkpoint '{p}'"),
    };
    lost.push(format!("{what} — {why}"));
}

/// The phase the last of `steps` may have ended, when the adapter could not be reached to replay
/// the driver's clock: the phase of the step before it, when it named one and the last step finished
/// the run or names another — the clock's rule (`observe`, `lib/cli-review-clock.mjs`), used here
/// only so an unreached writer's loss is said for a step that can have lost a checkpoint, and no
/// other.
fn ended_maybe(steps: &[Told]) -> Option<String> {
    let [.., before, now] = steps else {
        return None;
    };
    let ended = !before.done && !before.phase.is_empty() && (now.done || now.phase != before.phase);
    ended.then(|| before.phase.clone())
}

/// The run's record from the finished `step`: filed, landed with a warning, or failed.
pub(super) fn record(
    run: &Path,
    filing: &mut Filing,
    step: &Value,
    retry: bool,
    lost: &mut Vec<String>,
    w: &dyn Writer,
) {
    let asked = RecordAsked {
        common: Common::of(filing, filing.rejoin),
        step,
        retry,
        depth: &filing.ctx.depth,
        strict: filing.ctx.strict,
        via: &filing.ctx.via,
        output_tokens: filing.output_tokens,
    };
    let done = exchange::<_, RecordDone>(run, filing, "finalize", &asked, w).unwrap_or_else(|e| {
        RecordDone {
            ok: false,
            reason: e.to_string(),
            file: String::new(),
        }
    });
    filing.record_file = done.file;
    filing.record = if done.ok {
        Record::Filed
    } else {
        Record::Failed
    };
    if !done.ok {
        let why = if done.reason.is_empty() {
            "the writer gave no reason"
        } else {
            &done.reason
        };
        lost.push(format!("the run record — {why}"));
    } else if !done.reason.is_empty() {
        lost.push(format!(
            "the run directory (the record itself landed) — {}",
            done.reason
        ));
    }
}
