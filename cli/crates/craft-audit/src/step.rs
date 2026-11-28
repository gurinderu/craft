//! The audit on the step protocol (realm @nick/craft, nodes #453, #588): `start` scouts the project
//! and hands out the lens agents its first pass buys, `submit` takes their answers and hands out
//! the verifiers, then ends with the report and the record; `status` says where it stands. A
//! stopped run goes on by a submit without `--limit`; a finished one by `--resume`, which opens a
//! pass over the files left unread and the findings whose verifier died, or files again a record
//! that did not land.

mod advance;
mod aside;
mod filing;
mod finish;
mod halt;
mod open;
mod status;

use std::path::Path;

use craft_review::filing::Writer;
use craft_step::{Aside, Hold, take};
use serde_json::{Map, Value, json};

use crate::AuditError;
use crate::state::{self, AuditState, Phase, Task};

pub use finish::{finished_path, record_path, report_path, unread_path, unverified_path};
pub use halt::Said;
pub use open::{StartOptions, check_start, start};
pub use status::status;

/// Takes the answers to the pending tasks of the run in `dir` — from their files, or `given` by
/// task id — with what the host `said` of them, and hands out what comes next; `w` files the
/// record of a run that records once a pass ends.
///
/// # Errors
/// When the run is done with nothing to resume, a given answer names no pending task, or the
/// state or a file cannot be read or written.
pub fn submit(
    dir: &Path,
    given: Option<&Map<String, Value>>,
    said: &Said<'_>,
    w: &dyn Writer,
) -> Result<Value, AuditError> {
    let mut s = state::load(dir)?;
    if s.phase == Phase::Done {
        return halt::finished_again(dir, &mut s, said, w);
    }
    if s.stopped.is_some() && said.limit.is_some() {
        return Ok(halt::stopped(dir, &s));
    }
    take::note(&mut s.degraded, said.degraded);
    if let Some(id) = take::unknown(&s.tasks, given) {
        return Err(AuditError::UnknownTask(id.clone()));
    }
    let mut aside = Aside::default();
    take::abandon(dir, &mut s.tasks, said.abandoned, &mut aside)?;
    // A stopped run goes on: given no answers, its held tasks are handed out again, none counted.
    let was_stopped = s.stopped.take().is_some();
    if was_stopped && given.is_none() {
        return step(dir, &mut s, aside, None, w);
    }
    let hold = Hold::of(said.limit.is_some(), said.resume);
    take::take_pending(dir, &mut s.tasks, given, hold, &mut aside)?;
    step(dir, &mut s, aside, said.limit, w)
}

/// Moves the run on when none of its tasks is pending, saves it, sets the refused answers aside,
/// and says what comes next. On the host's `limit` the run moves on as far as its answers carry it
/// and stops where it still needs agents; a pass its answers finish ends.
fn step(
    dir: &Path,
    s: &mut AuditState,
    aside: Aside,
    limit: Option<&str>,
    w: &dyn Writer,
) -> Result<Value, AuditError> {
    let profiles = crate::scout::profiles()?;
    let finished = !s.tasks.iter().any(Task::pending) && advance::advance(s, &profiles)?;
    if let (Some(text), false) = (limit, finished) {
        halt::on_limit(s, text);
    }
    let done = if finished {
        Some(finish::end(dir, s, &profiles, w)?)
    } else {
        None
    };
    let ctx = crate::prompts::context(s);
    craft_step::handoff::write_pending(dir, &s.tasks, |t| {
        crate::prompts::written(&ctx, t).map_err(AuditError::from)
    })?;
    state::save(dir, s)?;
    aside::set_aside(dir, s, aside)?;
    if s.stopped.is_some() {
        return Ok(halt::stopped(dir, s));
    }
    if let Some(out) = done {
        return Ok(out);
    }
    let mut out = craft_step::wire::pending_step(dir, &s.tasks)?;
    if let Some(o) = out.as_object_mut() {
        o.insert("phase".into(), json!(s.phase));
        o.insert("pass".into(), json!(s.pass));
        o.insert("repo".into(), json!(s.cwd.display().to_string()));
    }
    halt::said(&mut out, s);
    Ok(out)
}

#[cfg(test)]
mod tests;
