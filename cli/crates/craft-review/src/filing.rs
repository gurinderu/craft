//! The run's own telemetry (realm @nick/craft, node #456): when the host asks for it at start
//! (`--record`), the binary files a checkpoint as each of its phases ends and the run record when
//! the run finishes, through `lib/cli-review-file.mjs` in craft's plugin root and the one write path
//! behind it, `lib/craft-log-run.mjs` — the record's shape is that JavaScript's, never rebuilt here.
//! What it needs between steps is kept beside the run's state in `filing.json`: the steps of the
//! current segment with the task agents the host had dispatched by each (the figures are replayed
//! from them), the directory the checkpoints went to, and whether the record is filed. A write that
//! does not land never fails a step: it is said in the step's `filing`, and a finished run whose
//! record failed files it again on `--resume` ([`refile`]), marked a retry so the store answers
//! `already filed` for an attempt that did land; a stopped run's `--resume` first files its stopped
//! segment's record the same way when it did not land, then opens a new segment.

mod kept;
pub mod node;
mod said;
#[cfg(test)]
mod tests;
mod wire;
mod write;

use std::path::Path;

use serde_json::Value;

pub use kept::{Ctx, Filing, Host, Record, Told, state_path};
use kept::{load, save};
pub use node::NodeWriter;
use said::outcome;
pub use said::{summary, with_filing};
pub use wire::{Call, WriteError, Writer};

/// Opens the run's telemetry after `start` printed `step`: the start checkpoint, and the record when
/// the run ended at once. Says what the writes did.
pub fn open(run: &Path, ctx: Ctx, session: &str, step: &Value, w: &dyn Writer) -> Value {
    let filing = Filing {
        ctx,
        session: session.into(),
        ..Filing::default()
    };
    record_step(run, filing, step, 0, Vec::new(), w)
}

/// Files what the submit that printed `step` closed, when the run files its telemetry; `None` when
/// it does not. A resume opens a new segment, the ended one's record filed first when it did not
/// land; a segment that ended — a stopped run submitted on — files nothing more.
pub fn submitted(run: &Path, step: &Value, host: &Host, w: &dyn Writer) -> Option<Value> {
    let mut filing = load(run)?;
    let mut lost = Vec::new();
    if host.resume {
        if let Some(ended) = unfiled(&filing) {
            file_record(run, &mut filing, &ended, &mut lost, w);
        }
        filing = Filing {
            ctx: filing.ctx,
            session: host.session.clone(),
            ..Filing::default()
        };
    } else if filing.finished.is_some() {
        return Some(outcome(&filing, lost, true));
    }
    if host.output_tokens.is_some() {
        filing.output_tokens = host.output_tokens;
    }
    Some(record_step(
        run,
        filing,
        step,
        host.agents.unwrap_or(0),
        lost,
        w,
    ))
}

/// The finished step of the segment whose record is not in the store, `None` when it is or the
/// segment has not ended.
fn unfiled(filing: &Filing) -> Option<Value> {
    filing
        .finished
        .clone()
        .filter(|_| filing.record != Record::Filed)
}

/// A finished run whose record is not in the store, filed again: its finished step with what the
/// write did; `None` when the run files no telemetry, is not finished — a stopped run is resumed,
/// not re-filed — or its record is filed.
pub fn refile(run: &Path, w: &dyn Writer) -> Option<Value> {
    let done = crate::state::load(run).is_ok_and(|s| s.phase == crate::state::Phase::Done);
    if done { file_again(run, w) } else { None }
}

/// [`refile`] of a run known to be finished.
fn file_again(run: &Path, w: &dyn Writer) -> Option<Value> {
    let mut filing = load(run)?;
    let step = unfiled(&filing)?;
    let mut lost = Vec::new();
    file_record(run, &mut filing, &step, &mut lost, w);
    save(run, &filing, &mut lost);
    Some(with_filing(step, outcome(&filing, lost, true)))
}

/// Keeps `step`, asks for the checkpoint it may call for — the start's on a segment's first step,
/// else the one of a phase it ended, which the adapter decides — and the record when it finished
/// the run.
fn record_step(
    run: &Path,
    mut filing: Filing,
    step: &Value,
    agents: u64,
    mut lost: Vec<String>,
    w: &dyn Writer,
) -> Value {
    filing.steps.push(Told::of(step, agents));
    let start = filing.steps.len() == 1;
    write::checkpoint(run, &mut filing, start, &mut lost, w);
    let done = is_done(step);
    if done {
        filing.finished = Some(step.clone());
        file_record(run, &mut filing, step, &mut lost, w);
    }
    save(run, &filing, &mut lost);
    outcome(&filing, lost, done)
}

/// One attempt at the record, counted and kept before it is made.
fn file_record(
    run: &Path,
    filing: &mut Filing,
    step: &Value,
    lost: &mut Vec<String>,
    w: &dyn Writer,
) {
    let retry = filing.attempts > 0;
    filing.attempts += 1;
    save(run, filing, lost);
    write::record(run, filing, step, retry, lost, w);
}

/// Whether `step` is the run's last: finished, or stopped to be resumed.
pub(super) fn is_done(step: &Value) -> bool {
    step.get("done").and_then(Value::as_bool).unwrap_or(false)
}
