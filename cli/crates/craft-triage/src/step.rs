//! The triage on the step protocol (realm @nick/craft, nodes #453, #610, #616): `start` opens a
//! run and hands out its first tasks, `submit` takes their answers and hands out what comes next,
//! `status` says where it stands. The finished step names the plan and the record, written beside
//! the state with their keys in the engine's order, and — when the run records — what filing the
//! record in the store did.

mod advance;
mod answers;
mod aside;
mod filing;
mod finished;
mod halt;
mod open;
mod refuse;
mod status;

use std::path::Path;

use craft_review::filing::Writer;
use craft_step::{Aside, Hold, take};
use serde_json::{Map, Value, json};

use crate::TriageError;
use crate::run::Phase;
use crate::state::{self, Task, TriageState};

use advance::advance;
use aside::set_aside;

pub use halt::Said;
pub use open::{StartOptions, start};
pub use status::status;

/// Takes the answers to the pending tasks of the run in `dir` — from their files, or `given` by
/// task id — with what the host `said` of them, and hands out what comes next; `w` files the record
/// of a run that records once it ends. A stopped run goes on by a submit without `--limit`, its
/// held tasks handed out again; a finished one only by `--resume`, to file a record that did not
/// land ([`halt`]).
///
/// # Errors
/// When the run is done, a given answer names no pending task, or the state or a file cannot be
/// read or written.
pub fn submit(
    dir: &Path,
    given: Option<&Map<String, Value>>,
    said: &Said<'_>,
    w: &dyn Writer,
) -> Result<Value, TriageError> {
    let mut s = state::load(dir)?;
    if s.phase == Phase::Done {
        return halt::finished_again(dir, &mut s, said, w);
    }
    if s.stopped.is_some() && said.limit.is_some() {
        return Ok(halt::stopped(dir, &s));
    }
    take::note(&mut s.degraded, said.degraded);
    if s.stopped.take().is_some() && given.is_none() {
        return step(dir, &mut s, Aside::default(), w);
    }
    if let Some(id) = take::unknown(&s.tasks, given) {
        return Err(TriageError::UnknownTask(id.clone()));
    }
    let mut aside = Aside::default();
    take::abandon(dir, &mut s.tasks, said.abandoned, &mut aside)?;
    let hold = Hold::of(said.limit.is_some(), said.resume);
    take::take_pending(dir, &mut s.tasks, given, hold, &mut aside)?;
    halt::on_limit(&mut s, said.limit);
    step(dir, &mut s, aside, w)
}

/// Moves the run on when it is not stopped and none of its tasks is pending, saves it, sets the
/// refused answers aside, and says what comes next. A finished run files its record first, so a
/// record that did not land leads its plan.
fn step(
    dir: &Path,
    s: &mut TriageState,
    aside: Aside,
    w: &dyn Writer,
) -> Result<Value, TriageError> {
    let finished = if s.stopped.is_some() || s.tasks.iter().any(Task::pending) {
        None
    } else {
        advance(s)?
    };
    let plan = finished
        .map(|done| finished::end(dir, s, &done, w))
        .transpose()?;
    craft_step::handoff::write_pending(dir, &s.tasks, |t| Ok::<_, TriageError>(t.prompt_text()))?;
    state::save(dir, s)?;
    set_aside(dir, s, aside)?;
    if s.stopped.is_some() {
        return Ok(halt::stopped(dir, s));
    }
    if let Some(plan) = plan {
        return finished::step(dir, &plan, s);
    }
    let mut out = craft_step::wire::pending_step(dir, &s.tasks)?;
    if let Some(o) = out.as_object_mut() {
        o.insert("phase".into(), json!(s.phase));
        o.insert("repo".into(), json!(s.cwd.display().to_string()));
    }
    finished::said(&mut out, s);
    Ok(out)
}

#[cfg(test)]
mod tests;
