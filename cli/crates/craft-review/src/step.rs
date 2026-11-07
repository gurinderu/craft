//! The step protocol (realm @nick/craft, node #453): the CLI decides what work a review needs and
//! starts no agent; the host runs the tasks each step hands out and submits their answers, and the
//! next step reads them. `start` opens a run, `submit` advances it, [`crate::status`] reads it.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::Error;
use crate::content;
use crate::coverage;
use crate::finished;
use crate::git;
use crate::handoff;
use crate::phases::{advance, finish};
use crate::profile::Profile;
use crate::prompts::{self, PromptContext, SPEC_MAX};
use crate::rounds::Rounds;
use crate::state::{
    self, MAX_RETRIES, Phase, RunState, STATE_VERSION, Task, TaskKind, TaskState, Track,
};
use crate::validate;

/// Why a run could not be opened or moved on, beyond its parts' own errors.
#[derive(Debug, thiserror::Error)]
pub enum StepError {
    #[error("reading the repository {}", path.display())]
    NoRepo {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("{} holds a run already", .0.display())]
    RunExists(PathBuf),
    #[error("{} holds files of another run", .0.display())]
    Leftovers(PathBuf),
    #[error("creating {}", path.display())]
    NoDir {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("the run in {} is done", .0.display())]
    Done(PathBuf),
    #[error("answer for {0}, which is no pending task of this run")]
    UnknownTask(String),
    #[error("the run has no plan")]
    NoPlan,
    #[error("writing {}", path.display())]
    NoReport {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// What `start` needs.
#[derive(Debug, Clone, Default)]
pub struct StartOptions {
    pub cwd: PathBuf,
    pub base: Option<String>,
    pub run_dir: PathBuf,
    /// craft's checkout and plugin version, for the review-rules paths the prompts name.
    pub craft_root: Option<String>,
    pub craft_version: Option<String>,
    /// A light pass (`depth=light`): the diff-scoped lenses, one round, only Medium and above
    /// verified.
    pub light: bool,
}

/// Opens a run in `opts.run_dir` and hands out its first tasks.
///
/// # Errors
/// When the repository or base cannot be read, the run directory holds a run already or a
/// non-empty `tasks/` or `answers/`, or the state cannot be written.
pub fn start(opts: &StartOptions) -> Result<Value, Error> {
    let cwd = opts
        .cwd
        .canonicalize()
        .map_err(|source| StepError::NoRepo {
            path: opts.cwd.clone(),
            source,
        })?;
    let diff = git::read_diff(&cwd, opts.base.as_deref())?;
    let dir = &opts.run_dir;
    if state::state_path(dir).exists() {
        return Err(StepError::RunExists(dir.clone()).into());
    }
    // A leftover task or answer file would be read as this run's.
    for sub in [handoff::tasks_dir(dir), handoff::answers_dir(dir)] {
        if sub.read_dir().is_ok_and(|mut d| d.next().is_some()) {
            return Err(StepError::Leftovers(sub).into());
        }
    }
    std::fs::create_dir_all(dir).map_err(|source| StepError::NoDir {
        path: dir.clone(),
        source,
    })?;
    let profiles = Profile::all()?;
    let context = PromptContext {
        repo: cwd.display().to_string(),
        base: diff.base.clone(),
        spec: diff.log.chars().take(SPEC_MAX).collect(),
        craft_root: opts.craft_root.clone(),
        craft_version: opts.craft_version.clone(),
    };
    let tracks: Vec<Track> = coverage::assign(&diff.files, &profiles)
        .into_iter()
        .filter_map(|(i, files)| Some(Track::new(&profiles.get(i)?.id, files)))
        .collect();
    let taken = |f: &str| tracks.iter().any(|t| t.files.iter().any(|x| x == f));
    let uncovered = coverage::uncovered(&diff.files, taken);
    let mut run = RunState {
        version: STATE_VERSION,
        tasks: Vec::new(),
        context,
        diff,
        tracks,
        uncovered,
        light: opts.light,
        phase: Phase::Scout,
        rounds: Rounds::default(),
        findings: Vec::new(),
        settled: Vec::new(),
        notes: Vec::new(),
        not_run: Vec::new(),
        degraded: Vec::new(),
        verdict: None,
        exit: None,
    };
    run.exit = coverage::exit(
        &run.diff,
        run.tracks.len(),
        &coverage::supported(&profiles),
        opts.base.is_some(),
    );
    if let Some(exit) = &run.exit {
        run.not_run.extend(exit.not_run.clone());
        finish(dir, &mut run)?;
    } else {
        run.tasks = scouts(&run, &profiles)?;
    }
    handoff::write_pending(dir, &run)?;
    state::save(dir, &run)?;
    Ok(next(dir, &run))
}

/// One scout per profile taking part of the change, each over its own files.
fn scouts(run: &RunState, profiles: &[Profile]) -> Result<Vec<Task>, Error> {
    let mut tasks = Vec::new();
    for t in &run.tracks {
        let Some(p) = profiles.iter().find(|p| p.id == t.profile) else {
            continue;
        };
        tasks.push(Task::new(
            format!("scout-{}", p.id),
            format!("scout:{}", p.id),
            prompts::scout_prompt(&run.context, p, &t.files)?,
            p.scout_model,
            content::schema("scout")?,
            TaskKind::Scout {
                profile: p.id.clone(),
            },
        ));
    }
    Ok(tasks)
}

/// Takes the answers to the pending tasks of the run in `dir` and hands out what comes next. The
/// answers are read from the files their agents wrote (`handoff`), or taken from `given`, a map by
/// task id, when the host passes them itself.
///
/// # Errors
/// When the run is done, a given answer names no pending task, or the state or a file cannot be read
/// or written.
pub fn submit(dir: &Path, given: Option<&Map<String, Value>>) -> Result<Value, Error> {
    submit_noting(dir, given, &[])
}

/// [`submit`], keeping `degraded`: how the host ran this step's tasks weaker than asked (a task
/// run without the agent it named), each note once, for the report and the finished step.
///
/// # Errors
/// As [`submit`].
pub fn submit_noting(
    dir: &Path,
    given: Option<&Map<String, Value>>,
    degraded: &[String],
) -> Result<Value, Error> {
    let mut run = state::load(dir)?;
    if run.phase == Phase::Done {
        return Err(StepError::Done(dir.to_owned()).into());
    }
    for note in degraded.iter().map(|n| n.trim()).filter(|n| !n.is_empty()) {
        if !run.degraded.iter().any(|d| d == note) {
            run.degraded.push(note.to_owned());
        }
    }
    let pending = |id: &str| {
        run.tasks
            .iter()
            .any(|t| t.id == id && t.state == TaskState::Pending)
    };
    if let Some(id) = given.and_then(|g| g.keys().find(|id| !pending(id))) {
        return Err(StepError::UnknownTask(id.clone()).into());
    }
    for task in run
        .tasks
        .iter_mut()
        .filter(|t| t.state == TaskState::Pending)
    {
        let submitted = match given {
            Some(g) => g
                .get(&task.id)
                .cloned()
                .ok_or_else(|| "no answer was submitted".to_owned()),
            None => handoff::read_answer(dir, task),
        };
        let checked = submitted
            .as_ref()
            .map_err(Clone::clone)
            .and_then(|a| validate::check(task, Some(a)));
        match checked {
            Ok(answer) => {
                task.answer = Some(answer);
                task.state = TaskState::Answered;
                task.error = None;
                task.refused = None;
                continue;
            }
            Err(e) => {
                task.error = Some(e);
                // An answer that came back but off its schema is a live vote, not a dead one.
                task.refused = submitted.ok().map(|a| validate::normalize(&a));
            }
        }
        if given.is_none() {
            handoff::set_aside(dir, task)?;
        }
        if task.retries < MAX_RETRIES {
            task.retries += 1;
        } else {
            task.state = TaskState::Failed;
        }
    }
    advance(dir, &mut run)?;
    handoff::write_pending(dir, &run)?;
    state::save(dir, &run)?;
    Ok(next(dir, &run))
}

/// What the host is to do next: the pending tasks, or the finished run's report, verdict and what
/// its run record carries (`finished`). Each names the head the run read, for the host's start
/// checkpoint.
fn next(dir: &Path, run: &RunState) -> Value {
    match &run.verdict {
        Some(v) if run.phase == Phase::Done => finished::step(dir, run, v),
        Some(_) | None => {
            let tasks: Vec<Value> = run
                .tasks
                .iter()
                .filter(|t| t.state == TaskState::Pending)
                .map(|t| handoff::wire(dir, t))
                .collect();
            json!({"run": dir.display().to_string(), "tasks": tasks, "done": false, "head": run.diff.head})
        }
    }
}
