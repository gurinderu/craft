//! The triage on the step protocol (realm @nick/craft, nodes #453, #610, #616): `start` opens a
//! run and hands out its first tasks, `submit` takes their answers and hands out what comes next,
//! `status` says where it stands. The finished step names the plan and the record, written beside
//! the state with their keys in the engine's order.

mod advance;
mod answers;
mod aside;
mod finished;
mod refuse;

use std::path::{Path, PathBuf};

use craft_step::{Aside, Hold, take};
use serde_json::{Map, Value, json};

use crate::TriageError;
use crate::run::{Args, Phase};
use crate::state::{self, STATE_VERSION, Task, TriageState};

use advance::advance;
use aside::set_aside;
use refuse::refuse;

/// What a triage run is opened with.
#[derive(Debug, Clone)]
pub struct StartOptions {
    /// The checkout the session runs in; `args.repo` names another.
    pub cwd: PathBuf,
    pub run_dir: PathBuf,
    pub args: Args,
}

/// Opens a run in `opts.run_dir` and hands out its first tasks.
///
/// # Errors
/// When the repository cannot be read, the run directory holds a run already, or the state or a
/// task's files cannot be written.
pub fn start(opts: &StartOptions) -> Result<Value, TriageError> {
    refuse(&opts.args)?;
    let repo = if opts.args.repo.is_empty() {
        opts.cwd.clone()
    } else {
        PathBuf::from(&opts.args.repo)
    };
    let cwd = repo
        .canonicalize()
        .map_err(|source| TriageError::NoRepo { path: repo, source })?;
    let dir = &opts.run_dir;
    if state::state_path(dir).exists() {
        return Err(TriageError::RunExists(dir.clone()));
    }
    std::fs::create_dir_all(dir).map_err(|source| TriageError::NoDir {
        path: dir.clone(),
        source,
    })?;
    let mut s = TriageState {
        version: STATE_VERSION,
        cwd,
        args: opts.args.clone(),
        phase: Phase::Gather,
        tasks: Vec::new(),
        seen: state::Seen::default(),
        degraded: Vec::new(),
        notes: Vec::new(),
    };
    step(dir, &mut s, Aside::default())
}

/// Takes the answers to the pending tasks of the run in `dir` — from their files, or `given` by
/// task id — and hands out what comes next; `degraded` says how the host ran them weaker than
/// asked.
///
/// # Errors
/// When the run is done, a given answer names no pending task, or the state or a file cannot be
/// read or written.
pub fn submit(
    dir: &Path,
    given: Option<&Map<String, Value>>,
    degraded: &[String],
) -> Result<Value, TriageError> {
    let mut s = state::load(dir)?;
    if s.phase == Phase::Done {
        return Err(TriageError::Done(dir.to_owned()));
    }
    if let Some(id) = take::unknown(&s.tasks, given) {
        return Err(TriageError::UnknownTask(id.clone()));
    }
    take::note(&mut s.degraded, degraded);
    let mut aside = Aside::default();
    take::take_pending(dir, &mut s.tasks, given, Hold::Nothing, &mut aside)?;
    step(dir, &mut s, aside)
}

/// Where the run in `dir` stands: its phase and each task's line.
///
/// # Errors
/// When its state cannot be read.
pub fn status(dir: &Path) -> Result<Value, TriageError> {
    let s = state::load(dir)?;
    let tasks: Vec<Value> = s.tasks.iter().map(craft_step::wire::status_line).collect();
    let mut out = json!({"run": dir.display().to_string(), "phase": s.phase, "done": s.phase == Phase::Done, "tasks": tasks});
    finished::said(&mut out, &s);
    if s.phase == Phase::Done {
        finished::files(&mut out, dir);
    }
    Ok(out)
}

/// Moves the run on when none of its tasks is pending, saves it, sets the refused answers aside,
/// and says what comes next.
fn step(dir: &Path, s: &mut TriageState, aside: Aside) -> Result<Value, TriageError> {
    let finished = if s.tasks.iter().any(Task::pending) {
        None
    } else {
        advance(s)?
    };
    let finished = finished.map(|done| finished::with_degraded(done, &s.degraded));
    if let Some(done) = &finished {
        finished::write(dir, done)?;
    }
    craft_step::handoff::write_pending(dir, &s.tasks, |t| Ok::<_, TriageError>(t.prompt_text()))?;
    state::save(dir, s)?;
    set_aside(dir, s, aside)?;
    if let Some(done) = finished {
        return finished::step(dir, &done, s);
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
