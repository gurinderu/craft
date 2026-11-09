//! The run's own telemetry (realm @nick/craft, node #456): when the host asks for it at start
//! (`--record`), the binary files a checkpoint as each of its phases ends and the run record when
//! the run finishes, through `lib/cli-review-file.mjs` in craft's plugin root and the one write path
//! behind it, `lib/craft-log-run.mjs` — the record's shape is that JavaScript's, never rebuilt here.
//! What it needs between steps is kept beside the run's state in `filing.json`: the steps of the
//! current segment with the task agents the host had dispatched by each (the figures are replayed
//! from them), the directory the checkpoints went to, and whether the record is filed. A write that
//! does not land never fails a step: it is said in the step's `filing`, and a finished run whose
//! record failed files it again on `--resume` ([`refile`]), marked a retry so the store answers
//! `already filed` for an attempt that did land.

mod kept;
pub mod node;
#[cfg(test)]
mod tests;
mod wire;
mod write;

use std::path::Path;

use serde_json::{Value, json};

pub use kept::{Ctx, Filing, Host, Record, Told, state_path};
use kept::{is_done, load, save};
pub use node::NodeWriter;
pub use write::{Call, WriteError, Writer};

/// Opens the run's telemetry after `start` printed `step`: the start checkpoint, and the record when
/// the run ended at once. Says what the writes did.
pub fn open(run: &Path, ctx: Ctx, session: &str, step: &Value, w: &dyn Writer) -> Value {
    let filing = Filing {
        ctx,
        session: session.into(),
        ..Filing::default()
    };
    record_step(run, filing, step, 0, w)
}

/// Files what the submit that printed `step` closed, when the run files its telemetry; `None` when
/// it does not.
pub fn submitted(run: &Path, step: &Value, host: &Host, w: &dyn Writer) -> Option<Value> {
    let mut filing = load(run)?;
    if host.resume {
        filing = Filing {
            ctx: filing.ctx,
            session: host.session.clone(),
            ..Filing::default()
        };
    }
    if host.output_tokens.is_some() {
        filing.output_tokens = host.output_tokens;
    }
    Some(record_step(run, filing, step, host.agents.unwrap_or(0), w))
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
    let step = filing
        .finished
        .clone()
        .filter(|_| filing.record != Record::Filed)?;
    let mut lost = Vec::new();
    file_record(run, &mut filing, &step, &mut lost, w);
    save(run, &filing, &mut lost);
    Some(with_filing(step, outcome(&filing, lost, true)))
}

/// `step` with the outcome of its telemetry under `filing`.
#[must_use]
pub fn with_filing(mut step: Value, filing: Value) -> Value {
    if let Some(obj) = step.as_object_mut() {
        obj.insert("filing".into(), filing);
    }
    step
}

/// Keeps `step`, writes the checkpoint it calls for — the start's on a segment's first step, else
/// the one of the phase it ended — and the record when it finished the run.
fn record_step(run: &Path, mut filing: Filing, step: &Value, agents: u64, w: &dyn Writer) -> Value {
    let mut lost = Vec::new();
    filing.steps.push(Told::of(step, agents));
    match filing.steps.as_slice() {
        [_] => write::checkpoint(run, &mut filing, "start", &mut lost, w),
        [.., before, now] if ended(before, now) => {
            let phase = before.phase.clone();
            write::checkpoint(run, &mut filing, &phase, &mut lost, w);
        }
        _ => {}
    }
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

/// Whether the step `now` ended the named phase the step `before` handed out tasks in: the rule the
/// driver's clock (`observe` in `lib/cli-review-clock.mjs`) ends a phase by, which the adapter
/// replays for the checkpoint's figures; a checkpoint it finds no ended phase for is skipped.
fn ended(before: &Told, now: &Told) -> bool {
    !before.done && !before.phase.is_empty() && (now.done || now.phase != before.phase)
}

/// What the writes after a step did, as the step's `filing` says it.
fn outcome(filing: &Filing, lost: Vec<String>, done: bool) -> Value {
    let mut v = json!({"runDir": filing.run_dir, "rejoin": filing.rejoin, "lost": lost});
    if let Some(obj) = v.as_object_mut().filter(|_| done) {
        obj.insert("record".into(), json!(filing.record));
    }
    v
}
