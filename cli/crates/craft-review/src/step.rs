//! The step protocol (realm @nick/craft, node #453): the CLI decides what work a review needs and
//! starts no agent; the host runs the tasks each step hands out and submits their answers, and the
//! next step reads them. `start` opens a run, `submit` advances it, [`crate::status`] reads it.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::Error;
use crate::coverage;
use crate::extra;
use crate::finished;
use crate::gate;
use crate::handoff;
use crate::memory::Memory;
use crate::phases::settle_memory;
use crate::profile::Profile;
use crate::prompts::{PromptContext, ReScope, SPEC_MAX};
use crate::publish::{self, PostSetup, Publish};
use crate::rereview;
use crate::rounds::Rounds;
use crate::state::{self, Phase, RunState, STATE_VERSION, TaskState, Track};
use crate::stop;
use crate::units;

mod answers;
mod open;
mod options;
mod prepare;

use answers::{Hold, abandon, move_on, take_answer};
use open::{open_dir, pr_worktree, read_change, refuse_delta_over_branch};
pub use options::StartOptions;
use prepare::{choose_extra, choose_units, prepare, scouts};

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
    #[error("HEAD moved since this run stopped ({old} → {new}); start a new review")]
    Moved { old: String, new: String },
    #[error(
        "tracked files changed since this run stopped (HEAD {0} unchanged); start a new review"
    )]
    Changed(String),
    #[error("the run has no plan")]
    NoPlan,
    #[error("writing {}", path.display())]
    NoReport {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error(transparent)]
    Scope(#[from] crate::scope::ScopeError),
    /// The pull request given (`pr`) has a head `HEAD` does not hold: the refusal, saying how to
    /// review its head ([`rereview::branch::resolve`]).
    #[error("{0}")]
    PrHead(String),
    /// `--delta` over a base at or before where the branch leaves origin's default branch:
    /// the round would review the whole branch with no earlier review behind it, yet never approve
    /// (realm @nick/craft, node #523).
    #[error(
        "--delta reviews only the fix commits since an earlier review, but the base {base} reaches \
         back to {point}, where this branch leaves {trunk}: the round would review the whole branch \
         with no earlier review behind it, and its verdict could never be Approve. Give --base the \
         commit an earlier review reviewed, or drop --delta for a full review"
    )]
    DeltaOverBranch {
        base: String,
        point: String,
        trunk: String,
    },
}

/// Opens a run in `opts.run_dir` and hands out its first tasks.
///
/// # Errors
/// When the repository or base cannot be read, the run directory holds a run already or a
/// non-empty `tasks/` or `answers/`, the pull request given (`pr`) has a head `HEAD` does not hold
/// ([`StepError::PrHead`]), or the state cannot be written.
pub fn start(opts: &StartOptions) -> Result<Value, Error> {
    let cwd = opts
        .cwd
        .canonicalize()
        .map_err(|source| StepError::NoRepo {
            path: opts.cwd.clone(),
            source,
        })?;
    let dir = &opts.run_dir;
    open_dir(dir)?;
    let (cwd, laid) = pr_worktree(cwd, dir, opts)?;
    let (scope, branch_diff) = read_change(&cwd, opts)?;
    let profiles = Profile::all()?;
    let runs = opts.runs_or_parent();
    let (mut chain, pr_note) = rereview::begin(
        &cwd,
        runs.as_deref().unwrap_or(dir),
        (opts.fresh, opts.nested),
        opts.full_every,
        &branch_diff.base,
        scope.as_deref(),
        opts.chain_lookup(dir),
    )?;
    chain.worktree = laid.map(|l| l.line);
    let pr_note = chain.worktree.clone().into_iter().chain(pr_note);
    let spec = branch_diff.log.chars().take(SPEC_MAX).collect();
    // The memory is recalled for the branch's paths, not only those a re-review's fix commits touch.
    let (recall_paths, recall_base) = (branch_diff.files.clone(), branch_diff.base.clone());
    let (diff, re_review) = rereview::scope(&cwd, &mut chain, branch_diff)?;
    refuse_delta_over_branch(&cwd, opts.delta, re_review, &diff)?;
    let context = PromptContext {
        repo: cwd.display().to_string(),
        base: diff.base.clone(),
        spec,
        craft_root: opts.craft_root.clone(),
        craft_version: opts.craft_version.clone(),
        re_review,
        strict: opts.strict,
        graph_project: crate::complexity::project(&cwd.display().to_string()).unwrap_or_default(),
        scope,
        ..PromptContext::default()
    };
    let (tracks, uncovered) = tracks_of(&diff.files, &profiles);
    let memory = Memory::open(opts.prior_decisions.clone());
    let (optional, unknown) = crate::optional::request(opts.optional.as_deref(), &profiles);
    let notes =
        crate::optional::unknown_note(opts.optional.as_deref().unwrap_or(""), &unknown, &profiles);
    let mut run = RunState {
        version: STATE_VERSION,
        tasks: Vec::new(),
        context,
        diff,
        tracks,
        uncovered,
        light: opts.light,
        delta: opts.delta,
        optional,
        phase: Phase::Scout,
        rounds: Rounds::default(),
        findings: Vec::new(),
        settled: Vec::new(),
        notes: notes.into_iter().chain(pr_note).collect(),
        not_run: Vec::new(),
        degraded: Vec::new(),
        verdict: None,
        exit: None,
        chain,
        memory: memory.recalling(opts.recall),
        gate: gate::Gate::default(),
        critic: crate::critic::Critic::default(),
        extra: extra::Extra::default(),
        units: units::Units::default(),
        watch: stop::Watch::default(),
        stopped: None,
        publish: Publish::asked(opts.comment),
        telemetry: crate::telemetry::Tally::default(),
    };
    run.exit = coverage::exit(
        &run.diff,
        run.tracks.len(),
        &coverage::supported(&profiles),
        opts.base.is_some() || re_review != ReScope::First,
    );
    // The prior round's open findings are adjudicated beside the scouts: neither waits on the other.
    let adjudicators = rereview::tasks(&run.context, &run.chain, &profiles)?;
    if let Some(exit) = &run.exit {
        run.not_run.extend(exit.not_run.clone());
    } else {
        prepare(&cwd, (dir, &profiles), opts, &mut run);
        // A red gate blocks before any lens, as `gateFailedExit` does.
        run.exit = run.gate.exit();
    }
    choose_units(&cwd, opts.unit_scope, &mut run, &profiles);
    choose_extra(&cwd, opts, &mut run);
    if run.exit.is_none() {
        run.tasks = scouts(&run, &profiles)?;
        let recall = opts.recall && !recall_paths.is_empty();
        if recall {
            let task = Memory::recall_task(&run.context.repo, &recall_paths, &recall_base)?;
            run.tasks.push(task);
        }
    }
    run.tasks.extend(adjudicators);
    first_step(dir, &mut run)
}

/// Each profile's part of the changed `files`, and the files no profile covers that carry
/// something to review.
pub(crate) fn tracks_of(files: &[String], profiles: &[Profile]) -> (Vec<Track>, Vec<String>) {
    let tracks: Vec<Track> = coverage::assign(files, profiles)
        .into_iter()
        .filter_map(|(i, files)| Some(Track::new(&profiles.get(i)?.id, files)))
        .collect();
    let taken = |f: &str| tracks.iter().any(|t| t.files.iter().any(|x| x == f));
    let uncovered = coverage::uncovered(files, taken);
    (tracks, uncovered)
}

/// The new run's first step: its tasks, or, with none to run, the run ended at once (with nothing
/// found, so nothing to post).
fn first_step(dir: &Path, run: &mut RunState) -> Result<Value, Error> {
    if run.tasks.is_empty() {
        settle_memory(dir, run)?;
    }
    save_and_next(dir, run, &Said::default())
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
    submit_with(
        dir,
        given,
        &Said {
            degraded,
            ..Said::default()
        },
    )
}

/// What the host says beside its answers.
#[derive(Debug, Clone, Copy, Default)]
pub struct Said<'a> {
    /// How it ran this step's tasks weaker than asked, as [`submit_noting`] keeps them.
    pub degraded: &'a [String],
    /// The account's usage limit, in the words an agent's error or short answer gave it: the run
    /// stops at once, keeping the answers that came in ([`crate::stop`]).
    pub limit: Option<&'a str>,
    /// The host resumes a run it lost (`--resume`: a stop it could not report, an interrupted
    /// host): an answer missing now is the round's agents never run, not a failed attempt, so its
    /// task is handed out again uncounted, and no dead round is read from it.
    pub resume: bool,
    /// How the defects of a run this submit finishes are posted on the PR; `None`, with gh on
    /// craft's own PATH within the default budget.
    pub post: Option<&'a PostSetup>,
    /// The tasks whose agents the host abandoned at their deadline (`--abandoned`): each fails at
    /// once, never handed out again, and an answer its agent writes later is never read.
    pub abandoned: &'a [String],
}

/// [`submit`] with what the host `said`. A stopped run is resumed by a submit without a limit —
/// `--resume`, as its stop says; the binary refuses a plain one for a run that files its telemetry
/// (`bin/craft`, `refuse_folded`) — its held tasks handed out again, and nothing read for them. A resume — of a stopped run, or
/// `said.resume` — goes on only over the tree the run started on ([`crate::resume`]).
///
/// # Errors
/// As [`submit`], and [`StepError::Moved`] or [`StepError::Changed`] for a resume over another
/// tree.
pub fn submit_with(
    dir: &Path,
    given: Option<&Map<String, Value>>,
    said: &Said<'_>,
) -> Result<Value, Error> {
    let mut run = state::load(dir)?;
    if run.phase == Phase::Done {
        return Err(StepError::Done(dir.to_owned()).into());
    }
    if said.resume || (run.stopped.is_some() && said.limit.is_none()) {
        crate::resume::unmoved(&run)?;
    }
    if run.stopped.is_some() {
        if said.limit.is_some() {
            return stop::step(dir, &run);
        }
        run.stopped = None;
        if given.is_none() {
            return save_and_next(dir, &mut run, said);
        }
    }
    for note in said
        .degraded
        .iter()
        .map(|n| n.trim())
        .filter(|n| !n.is_empty())
    {
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
    abandon(dir, &mut run, said.abandoned)?;
    stop::open(&mut run);
    let hold = match (said.limit, said.resume) {
        (Some(_), _) => Hold::Every,
        (None, true) => Hold::Missing,
        (None, false) => Hold::Nothing,
    };
    for task in run
        .tasks
        .iter_mut()
        .filter(|t| t.state == TaskState::Pending)
    {
        let live = take_answer(dir, task, given, hold)?;
        run.watch.live |= live;
    }
    move_on(dir, &mut run, said)?;
    save_and_next(dir, &mut run, said)
}

/// Posts a run that finished on its PR when it was asked to, writes the pending tasks and the
/// state, and says what comes next: the stop, when the run stopped.
fn save_and_next(dir: &Path, run: &mut RunState, said: &Said<'_>) -> Result<Value, Error> {
    let setup = said.post.cloned().unwrap_or_default();
    publish::deliver(dir, run, &setup)?;
    handoff::write_pending(dir, run)?;
    state::save(dir, run)?;
    if run.stopped.is_some() {
        return stop::step(dir, run);
    }
    Ok(next(dir, run))
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
            let mut step = json!({"run": dir.display().to_string(), "tasks": tasks, "done": false, "head": run.diff.head, "repo": run.context.repo, "phase": run.phase});
            finished::name_worktree(&mut step, run);
            step
        }
    }
}
