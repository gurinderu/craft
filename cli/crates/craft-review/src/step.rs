//! The step protocol (realm @nick/craft, node #453): the CLI decides what work a review needs and
//! starts no agent; the host runs the tasks each step hands out and submits their answers, and the
//! next step reads them. `start` opens a run, `submit` advances it, [`crate::status`] reads it.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde_json::{Map, Value, json};

use crate::content;
use crate::git;
use crate::handoff;
use crate::phases::{advance, finish};
use crate::profile::Profile;
use crate::prompts::{self, PromptContext, SPEC_MAX};
use crate::rounds::Rounds;
use crate::state::{self, MAX_RETRIES, Phase, RunState, STATE_VERSION, Task, TaskKind, TaskState};
use crate::validate;

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
pub fn start(opts: &StartOptions) -> Result<Value> {
    let cwd = opts
        .cwd
        .canonicalize()
        .with_context(|| format!("reading the repository {}", opts.cwd.display()))?;
    let diff = git::read_diff(&cwd, opts.base.as_deref())?;
    let dir = &opts.run_dir;
    if state::state_path(dir).exists() {
        bail!("{} holds a run already", dir.display());
    }
    // A leftover task or answer file would be read as this run's.
    for sub in [handoff::tasks_dir(dir), handoff::answers_dir(dir)] {
        if sub.read_dir().is_ok_and(|mut d| d.next().is_some()) {
            bail!("{} holds files of another run", sub.display());
        }
    }
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let profile = Profile::rust()?;
    let context = PromptContext {
        repo: cwd.display().to_string(),
        base: diff.base.clone(),
        spec: diff.log.chars().take(SPEC_MAX).collect(),
        craft_root: opts.craft_root.clone(),
        craft_version: opts.craft_version.clone(),
    };
    let rust_files: Vec<String> = diff
        .files
        .iter()
        .filter(|f| profile.covers(f))
        .cloned()
        .collect();
    let mut run = RunState {
        version: STATE_VERSION,
        tasks: Vec::new(),
        context,
        diff,
        rust_files,
        light: opts.light,
        phase: Phase::Scout,
        plan: None,
        rounds: Rounds::default(),
        findings: Vec::new(),
        votes: Vec::new(),
        notes: Vec::new(),
        not_run: Vec::new(),
        verdict: None,
    };
    if run.rust_files.is_empty() {
        run.notes
            .push("the diff changes no file the Rust profile reviews: nothing to review".into());
        finish(dir, &mut run)?;
    } else {
        run.tasks = vec![Task::new(
            format!("scout-{}", profile.id),
            format!("scout:{}", profile.id),
            prompts::scout_prompt(&run.context, &profile)?,
            &profile.scout_model,
            content::schema("scout")?,
            TaskKind::Scout,
        )];
    }
    handoff::write_pending(dir, &run)?;
    state::save(dir, &run)?;
    Ok(next(dir, &run))
}

/// Takes the answers to the pending tasks of the run in `dir` and hands out what comes next. The
/// answers are read from the files their agents wrote (`handoff`), or taken from `given`, a map by
/// task id, when the host passes them itself.
///
/// # Errors
/// When the run is done, a given answer names no pending task, or the state or a file cannot be read
/// or written.
pub fn submit(dir: &Path, given: Option<&Map<String, Value>>) -> Result<Value> {
    let mut run = state::load(dir)?;
    if run.phase == Phase::Done {
        bail!("the run in {} is done", dir.display());
    }
    let pending = |id: &str| {
        run.tasks
            .iter()
            .any(|t| t.id == id && t.state == TaskState::Pending)
    };
    if let Some(id) = given.and_then(|g| g.keys().find(|id| !pending(id))) {
        bail!("answer for {id}, which is no pending task of this run");
    }
    for task in run
        .tasks
        .iter_mut()
        .filter(|t| t.state == TaskState::Pending)
    {
        let checked = match given {
            Some(g) => validate::check(task, g.get(&task.id)),
            None => handoff::read_answer(dir, task).and_then(|a| validate::check(task, Some(&a))),
        };
        match checked {
            Ok(answer) => {
                task.answer = Some(answer);
                task.state = TaskState::Answered;
                task.error = None;
                continue;
            }
            Err(e) => task.error = Some(e),
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

/// What the host is to do next: the pending tasks, or the finished run's report and verdict.
fn next(dir: &Path, run: &RunState) -> Value {
    match &run.verdict {
        Some(v) if run.phase == Phase::Done => {
            json!({"run": dir.display().to_string(), "done": true, "report": state::report_path(dir).display().to_string(), "verdict": v})
        }
        Some(_) | None => {
            let tasks: Vec<Value> = run
                .tasks
                .iter()
                .filter(|t| t.state == TaskState::Pending)
                .map(|t| handoff::wire(dir, t))
                .collect();
            json!({"run": dir.display().to_string(), "tasks": tasks, "done": false})
        }
    }
}
