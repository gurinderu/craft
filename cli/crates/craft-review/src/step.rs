//! The step protocol (realm @nick/craft, node #453): the CLI decides what work a review needs and
//! starts no agent; the host runs the tasks each step hands out and submits their answers, and the
//! next step reads them. `start` opens a run, `submit` advances it, [`crate::status`] reads it.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde_json::{Map, Value, json};

use crate::content;
use crate::git;
use crate::prompts::{self, LENS, PromptContext};
use crate::report;
use crate::state::{self, MAX_RETRIES, Phase, RunState, STATE_VERSION, Task, TaskKind, TaskState};
use crate::validate;
use crate::verify;

const LENS_MODEL: &str = "opus";

/// What `start` needs.
#[derive(Debug, Clone, Default)]
pub struct StartOptions {
    pub cwd: PathBuf,
    pub base: Option<String>,
    pub run_dir: PathBuf,
    /// craft's checkout and plugin version, for the review-rules paths the prompts name.
    pub craft_root: Option<String>,
    pub craft_version: Option<String>,
}

/// Opens a run in `opts.run_dir` and hands out its first tasks.
///
/// # Errors
/// When the repository or base cannot be read, the run directory holds a run already, or the
/// state cannot be written.
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
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let context = PromptContext {
        repo: cwd.display().to_string(),
        base: diff.base.clone(),
        spec: diff.log.clone(),
        craft_root: opts.craft_root.clone(),
        craft_version: opts.craft_version.clone(),
    };
    let rust_files: Vec<String> = diff
        .files
        .iter()
        .filter(|f| f.ends_with(".rs"))
        .cloned()
        .collect();
    let mut run = RunState {
        version: STATE_VERSION,
        tasks: Vec::new(),
        context,
        diff,
        rust_files,
        phase: Phase::Lens,
        findings: Vec::new(),
        votes: Vec::new(),
        notes: Vec::new(),
        verdict: None,
    };
    if run.rust_files.is_empty() {
        run.notes
            .push("the diff changes no Rust file: nothing to review".into());
        finish(dir, &mut run, false)?;
    } else {
        let prompt = prompts::lens_prompt(&run.context)?;
        let schema = content::schema("findings")?;
        let id = format!("lens:{LENS}");
        run.tasks = vec![Task::new(
            id.clone(),
            id,
            prompt,
            LENS_MODEL,
            schema,
            TaskKind::Lens,
        )];
    }
    state::save(dir, &run)?;
    Ok(next(dir, &run))
}

/// Takes the answers to the pending tasks of the run in `dir` and hands out what comes next.
///
/// # Errors
/// When the run is done, an answer names no pending task, or the state cannot be read or written.
pub fn submit(dir: &Path, answers: &Map<String, Value>) -> Result<Value> {
    let mut run = state::load(dir)?;
    if run.phase == Phase::Done {
        bail!("the run in {} is done", dir.display());
    }
    let pending = |id: &str| {
        run.tasks
            .iter()
            .any(|t| t.id == id && t.state == TaskState::Pending)
    };
    if let Some(id) = answers.keys().find(|id| !pending(id)) {
        bail!("answer for {id}, which is no pending task of this run");
    }
    for task in run
        .tasks
        .iter_mut()
        .filter(|t| t.state == TaskState::Pending)
    {
        match validate::check(task, answers.get(&task.id)) {
            Ok(answer) => {
                task.answer = Some(answer);
                task.state = TaskState::Answered;
                task.error = None;
            }
            Err(e) if task.retries < MAX_RETRIES => {
                task.retries += 1;
                task.error = Some(e);
            }
            Err(e) => {
                task.state = TaskState::Failed;
                task.error = Some(e);
            }
        }
    }
    advance(dir, &mut run)?;
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
                .map(Task::wire)
                .collect();
            json!({"run": dir.display().to_string(), "tasks": tasks, "done": false})
        }
    }
}

/// Moves the run on once no task is pending: the lens's findings to verification, the verdicts to
/// the report.
fn advance(dir: &Path, run: &mut RunState) -> Result<()> {
    if run.tasks.iter().any(|t| t.state == TaskState::Pending) {
        return Ok(());
    }
    match run.phase {
        Phase::Lens => {
            let lens = run.tasks.first().context("the run has no lens task")?;
            if lens.state == TaskState::Failed {
                let why = lens.error.clone().unwrap_or_default();
                run.notes
                    .push(format!("the {LENS} lens gave no valid answer: {why}"));
                return finish(dir, run, true);
            }
            run.findings = lens
                .answer
                .as_ref()
                .and_then(|a| a.get("findings"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            run.votes = vec![None; run.findings.len()];
            if run.findings.is_empty() {
                return finish(dir, run, false);
            }
            run.tasks = verify::tasks(run)?;
            run.phase = Phase::Verify;
            Ok(())
        }
        Phase::Verify => {
            verify::collect_votes(run);
            finish(dir, run, false)
        }
        Phase::Done => Ok(()),
    }
}

/// Ends the run: its verdict, and the report written beside the state.
fn finish(dir: &Path, run: &mut RunState, lens_failed: bool) -> Result<()> {
    let verdict = report::verdict(run, lens_failed);
    let path = state::report_path(dir);
    std::fs::write(&path, report::markdown(run, verdict))
        .with_context(|| format!("writing {}", path.display()))?;
    run.verdict = Some(verdict.to_owned());
    run.phase = Phase::Done;
    Ok(())
}
