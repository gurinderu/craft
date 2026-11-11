//! The step protocol (realm @nick/craft, node #453): the CLI decides what work a review needs and
//! starts no agent; the host runs the tasks each step hands out and submits their answers, and the
//! next step reads them. `start` opens a run, `submit` advances it, [`crate::status`] reads it.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::Error;
use crate::complexity;
use crate::content;
use crate::coverage;
use crate::extra;
use crate::finished;
use crate::gate::{self, GateSetup};
use crate::git;
use crate::handoff;
use crate::memory::Memory;
use crate::phases::{advance, settle_memory};
use crate::profile::Profile;
use crate::prompts::{self, PromptContext, ReScope, SPEC_MAX};
use crate::publish::{self, PostSetup, Publish};
use crate::rereview;
use crate::rounds::Rounds;
use crate::sources::{self, SourcesSetup};
use crate::state::{
    self, MAX_RETRIES, Phase, RunState, STATE_VERSION, Task, TaskKind, TaskState, Track,
};
use crate::stop;
use crate::units;
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
    /// The pull request given (`pr`) has a head other than `HEAD`: the refusal, saying how to
    /// review its head ([`rereview::branch::resolve`]).
    #[error("{0}")]
    PrHead(String),
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
    /// Start a new chain of rounds rather than build on the branch's earlier round.
    pub fresh: bool,
    /// Every this-many-th round of a chain reviews the whole diff again; 0, never.
    pub full_every: u32,
    /// Where earlier runs are looked for; the run directory's parent when `None`.
    pub runs: Option<PathBuf>,
    /// Strict mode: the maintainability bar is a presumption of block.
    pub strict: bool,
    /// The launcher's own records (`priorDecisions`) as given, added to what the run recalls; `Err`
    /// names why the host's list could not be read, which refuses it and runs the review anyway.
    pub prior_decisions: Option<Result<Value, String>>,
    /// Recall the project's memory beside the scouts; without it only `prior_decisions` apply.
    pub recall: bool,
    /// Where the reviewer's profile and the sources cache are: the integration points' sources are
    /// prepared before the first tasks. `None`, none are.
    pub sources: Option<SourcesSetup>,
    /// How the mechanical gate runs its tools before the scouts; `None`, it does not run, and the
    /// report says so.
    pub gate: Option<GateSetup>,
    /// The launching run's gate to take rather than run one (`--gate-from`, the directory
    /// `craft review gate` wrote): its seeds on this run's files reach the lenses
    /// ([`gate::alone::taken`]); over `gate` when both are given.
    pub gate_from: Option<PathBuf>,
    /// The consumer's own agents to run as extra lenses, as the host names them (`extraLenses`):
    /// names separated by commas or spaces, or `off`; `None`, discovered on a light pass and off
    /// on a full review ([`crate::extra::request`]).
    pub extra_lenses: Option<String>,
    /// The directory the host session runs in, whose project's `.claude/agents` discovery reads;
    /// the process's working directory when `None`.
    pub session: Option<PathBuf>,
    /// Unit mode (`unitScope`, off by default): each sliceable lens confined to a batch of the
    /// units its profile finds, a contract lens per touched unit and a coordinator after the rounds
    /// ([`crate::units`]).
    pub unit_scope: bool,
    /// The directory (or file) of the change to review (`path`), repository-relative or absolute
    /// inside the repository; `None`, the whole change ([`crate::scope`]).
    pub path: Option<String>,
    /// Publish the findings on the branch's PR when the run finishes (`comment`): the defects
    /// posted with the craft-finding marker, the doubtful ones listed for the reviewer
    /// ([`crate::publish`]); off, nothing is posted.
    pub comment: bool,
    /// The optional lenses to run (`optional`): `all`, or their names separated by commas or
    /// spaces; `None`, none ([`crate::optional`]).
    pub optional: Option<String>,
    /// A parent engine launched the run (`nested`): it builds on no earlier round of the branch
    /// and files no round record for a later one, as the engine keeps a nested run out of the chain.
    pub nested: bool,
    /// The pull request under review (`pr`), whose head `HEAD` must be, else the run is refused: on
    /// a detached `HEAD` its head branch keys the round chain ([`rereview::branch`]); `None`, gh is
    /// asked for the open one whose head is `HEAD`.
    pub pr: Option<u64>,
    /// How gh is asked for that pull request; `None`, it is not asked and a detached `HEAD`
    /// chains nothing.
    pub chain_gh: Option<PostSetup>,
}

impl StartOptions {
    /// How the run in `dir` asks gh for the pull request a detached `HEAD` heads, its output kept
    /// in `dir/chain`.
    fn chain_lookup(&self, dir: &Path) -> rereview::branch::Lookup<'_> {
        rereview::branch::Lookup {
            pr: self.pr,
            gh: self.chain_gh.as_ref(),
            dir: dir.join("chain"),
        }
    }
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
    let (scope, branch_diff) = read_change(&cwd, opts)?;
    let dir = &opts.run_dir;
    open_dir(dir)?;
    let profiles = Profile::all()?;
    let runs = opts
        .runs
        .clone()
        .or_else(|| dir.parent().map(Path::to_path_buf));
    let (mut chain, pr_note) = rereview::begin(
        &cwd,
        runs.as_deref().unwrap_or(dir),
        (opts.fresh, opts.nested),
        opts.full_every,
        &branch_diff.base,
        scope.as_deref(),
        opts.chain_lookup(dir),
    )?;
    let spec = branch_diff.log.chars().take(SPEC_MAX).collect();
    // The memory is recalled for the branch's paths, not only those a re-review's fix commits touch.
    let (recall_paths, recall_base) = (branch_diff.files.clone(), branch_diff.base.clone());
    let (diff, re_review) = rereview::scope(&cwd, &mut chain, branch_diff)?;
    let context = PromptContext {
        repo: cwd.display().to_string(),
        base: diff.base.clone(),
        spec,
        craft_root: opts.craft_root.clone(),
        craft_version: opts.craft_version.clone(),
        re_review,
        strict: opts.strict,
        sources: sources::Sources::default(),
        scope,
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
        prepare(&cwd, dir, opts, &mut run);
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

/// The scope the run reviews (`path`, repository-relative) and the branch's change under it.
fn read_change(cwd: &Path, opts: &StartOptions) -> Result<(Option<String>, git::Diff), Error> {
    let scope = match opts.path.as_deref() {
        Some(p) => crate::scope::normalize(&git::toplevel(cwd)?, p).map_err(StepError::from)?,
        None => None,
    };
    let diff = git::read_diff(cwd, opts.base.as_deref(), scope.as_deref())?;
    Ok((scope, diff))
}

/// The slices of the change when the run goes on to its lenses: under unit mode, when asked, the
/// units of each profile taking part, discovered in the repository's top level, and their batches;
/// else the normal mode's directory slices.
fn choose_units(cwd: &Path, asked: bool, run: &mut RunState, profiles: &[Profile]) {
    run.units.asked = asked;
    if run.exit.is_some() {
        return;
    }
    let top = git::toplevel(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let d = &run.diff;
    run.units = units::open(asked, &top, &d.base, &d.files, &run.tracks, profiles);
}

/// The extra lenses the run is asked for, discovered among the session project's agents when it
/// asks for discovery and goes on to its lenses; a run ending here says they did not run.
fn choose_extra(cwd: &Path, opts: &StartOptions, run: &mut RunState) {
    run.extra = extra::request(opts.extra_lenses.as_deref(), opts.light);
    if run.exit.is_some() {
        extra::not_reached(run);
        return;
    }
    if run.extra.how == extra::How::Discovered {
        let session = opts
            .session
            .clone()
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| cwd.to_path_buf());
        let (agents, read) = extra::discover(&session, cwd);
        run.extra.agents = agents;
        run.extra.discovery = read;
    }
}

/// Makes `dir` the new run's: refused when it holds a run, or a task or answer file that would be
/// read as this run's.
fn open_dir(dir: &Path) -> Result<(), StepError> {
    if state::state_path(dir).exists() {
        return Err(StepError::RunExists(dir.to_owned()));
    }
    for sub in [handoff::tasks_dir(dir), handoff::answers_dir(dir)] {
        if sub.read_dir().is_ok_and(|mut d| d.next().is_some()) {
            return Err(StepError::Leftovers(sub));
        }
    }
    std::fs::create_dir_all(dir).map_err(|source| StepError::NoDir {
        path: dir.to_owned(),
        source,
    })
}

/// The integration points' sources and the gate, side by side, neither waiting on the other: the
/// sources reach the prompts, the gate's seeds the pool as round-0 findings.
fn prepare(cwd: &Path, dir: &Path, opts: &StartOptions, run: &mut RunState) {
    let (prepared, gated) = std::thread::scope(|s| {
        let sources = s.spawn(|| {
            opts.sources
                .as_ref()
                .map(|setup| sources::for_repo(cwd, setup))
        });
        let gated = match &opts.gate_from {
            Some(from) => Some(gate::alone::taken(from, &run.diff)),
            None => opts
                .gate
                .as_ref()
                .map(|setup| GateSetup {
                    scope: run.context.scope.clone(),
                    ..setup.clone()
                })
                .map(|setup| gate::run(cwd, &run.diff.base, &run.tracks, &setup, dir)),
        };
        (sources.join(), gated)
    });
    match prepared {
        Ok(Some(s)) => run.context.sources = s,
        Ok(None) => {}
        Err(_) => {
            run.context.sources.skipped = "the sources' preparation stopped unexpectedly".into();
        }
    }
    match gated {
        Some((gate, seeds)) => {
            // A red gate ends the run before any lens: its seeds are no one's to read.
            if gate.exit().is_none() {
                run.rounds.pool = seeds;
            }
            run.gate = gate;
        }
        None => run.gate = gate::Gate::not_asked(),
    }
}

/// One scout per profile taking part of the change, each over its own files; beside them the index
/// warm-up when a profile taking part has a metrics-or-nothing lens.
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
    let taking_part = |p: &&Profile| run.tracks.iter().any(|t| t.profile == p.id);
    if profiles.iter().filter(taking_part).any(complexity::wanted) {
        tasks.push(complexity::warmup_task(&run.context.repo)?);
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

/// Which failed answers wait uncounted rather than use up a retry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Hold {
    Nothing,
    /// The missing ones (a resume).
    Missing,
    /// Every one (the host's limit).
    Every,
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

/// Fails each pending task of `ids`, abandoned by the host at its deadline, as the engine counts a
/// deadline fire: a dead agent not dispatched again, whose wait already spent the budget. Its
/// answer file, should one be there, is set aside unread.
fn abandon(dir: &Path, run: &mut RunState, ids: &[String]) -> Result<(), Error> {
    for task in run
        .tasks
        .iter_mut()
        .filter(|t| t.state == TaskState::Pending && ids.contains(&t.id))
    {
        handoff::set_aside(dir, task)?;
        task.state = TaskState::Failed;
        task.abandoned = true;
        task.error = Some(
            "abandoned at its deadline: the host waited its whole budget and no answer came back, so it is not asked for again".into(),
        );
    }
    Ok(())
}

/// Moves the run on once this submit's answers are in: stopped on the host's limit (after
/// advancing when nothing is left to wait for) or on a round that died whole — never read from a
/// resume, whose missing answers are held — else advanced.
fn move_on(dir: &Path, run: &mut RunState, said: &Said<'_>) -> Result<(), Error> {
    if let Some(text) = said.limit {
        if run.tasks.iter().all(|t| t.state != TaskState::Pending) {
            advance(dir, run)?;
        }
        if run.phase != Phase::Done {
            stop::hold(run, stop::limit(text));
        }
        return Ok(());
    }
    match stop::round_died(run).filter(|_| !said.resume) {
        Some(why) => stop::hold(run, stop::deaths(why)),
        None => advance(dir, run)?,
    }
    Ok(())
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

/// Takes the answer of one pending task, from `given` or the file its agent wrote; one refused is
/// asked for again until its retries are spent — unless `hold` keeps it waiting uncounted: every
/// one on the host's limit, a missing one on a resume (handed out again as first written). Says
/// whether its agent answered at all, valid or not.
fn take_answer(
    dir: &Path,
    task: &mut Task,
    given: Option<&Map<String, Value>>,
    hold: Hold,
) -> Result<bool, Error> {
    let submitted = match given {
        Some(g) => g
            .get(&task.id)
            .cloned()
            .ok_or_else(|| "no answer was submitted".to_owned()),
        None => handoff::read_answer(dir, task),
    };
    // An answer file that cannot be read or parsed was still written: its agent was alive.
    let live = match given {
        Some(g) => g.contains_key(&task.id),
        None => handoff::answer_file(dir, &task.id).exists(),
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
            return Ok(true);
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
    match hold {
        Hold::Every => return Ok(live),
        Hold::Missing if !live => {
            // Handed out again as first written, its ladder whole, as `stop::hold` holds a task.
            task.retries = 0;
            task.error = None;
            task.refused = None;
            return Ok(false);
        }
        Hold::Missing | Hold::Nothing => {}
    }
    if task.retries < MAX_RETRIES {
        task.retries += 1;
    } else {
        task.state = TaskState::Failed;
    }
    Ok(live)
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
            json!({"run": dir.display().to_string(), "tasks": tasks, "done": false, "head": run.diff.head, "repo": run.context.repo, "phase": run.phase})
        }
    }
}
