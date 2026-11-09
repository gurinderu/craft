//! The two writes and how their answers are read: what `lib/cli-review-file.mjs` is handed for a
//! checkpoint or the record, and what each answer does to the run's telemetry. A write that does
//! not land is one line of `lost`, `<what> — <why>`, as the driver's notes word it.

use std::path::Path;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::wire::{CheckpointAsked, CheckpointDone, Common, RecordAsked, RecordDone};
use super::{Filing, Record};

/// One write as the adapter is asked for it.
#[derive(Debug, Clone, Copy)]
pub struct Call<'a> {
    pub run: &'a Path,
    pub root: &'a str,
    pub repo: &'a str,
    /// `checkpoint` or `finalize`.
    pub command: &'a str,
    pub request: &'a Value,
}

/// Why a write did not come back with an answer.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WriteError {
    #[error("no craft plugin root is known to the run, so the record writer cannot be found")]
    NoRoot,
    #[error("node is not on the PATH")]
    NoNode,
    #[error("the record writer did not finish within {0} s")]
    TimedOut(u64),
    #[error("the record writer could not run: {0}")]
    Broken(String),
    #[error("the record writer exited non-zero: {0}")]
    Exited(String),
    #[error("the record writer printed no answer: {0}")]
    NoAnswer(String),
}

/// Runs a write: the real one spawns node over the adapter ([`super::NodeWriter`]).
pub trait Writer {
    /// The JSON object the adapter answered.
    ///
    /// # Errors
    /// When it could not be run or printed no answer.
    fn write(&self, call: &Call<'_>) -> Result<Value, WriteError>;
}

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

/// The checkpoint of `phase` (`start`, or the phase the last step ended): the directory it landed
/// in kept for the next write, a failure said.
pub(super) fn checkpoint(
    run: &Path,
    filing: &mut Filing,
    phase: &str,
    lost: &mut Vec<String>,
    w: &dyn Writer,
) {
    let armed = filing.run_dir.is_empty() && filing.failed;
    filing.rejoin |= armed;
    let asked = CheckpointAsked {
        common: Common::of(filing, armed),
        start: phase == "start",
    };
    let why = match exchange::<_, CheckpointDone>(run, filing, "checkpoint", &asked, w) {
        Ok(d) if d.skipped => return,
        Ok(d) if !d.run_dir.is_empty() => {
            filing.run_dir = d.run_dir;
            return;
        }
        Ok(d) if !d.error.is_empty() => d.error,
        Ok(_) => "the writer named no run directory".to_owned(),
        Err(e) => e.to_string(),
    };
    filing.failed = true;
    lost.push(format!("phase checkpoint '{phase}' — {why}"));
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
        }
    });
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
