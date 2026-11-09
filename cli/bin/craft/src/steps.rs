//! `craft review start | submit | status`: the step protocol (realm @nick/craft, node #453) on the
//! command line. Each prints one JSON value on stdout; an error is one line on stderr and a
//! non-zero exit (`main`).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use craft_review::{filing, prompts, status, step};
use serde_json::{Map, Value, json};

use crate::review::find_craft_root;

#[derive(Debug, clap::Args)]
pub struct StartArgs {
    /// The repository to review.
    #[arg(long, default_value = ".")]
    pub cwd: PathBuf,
    /// What the changes are measured against; the merge-base with origin's default branch when
    /// absent.
    #[arg(long)]
    pub base: Option<String>,
    /// Where the run keeps its state; a new directory under ~/.craft/runs/cli when absent.
    #[arg(long)]
    pub run_dir: Option<PathBuf>,
    /// craft's plugin root, named in the prompts; found above the executable when absent.
    #[arg(long, env = "CRAFT_ROOT")]
    pub craft_root: Option<PathBuf>,
    /// `light`: the diff-scoped lenses, one round, only Medium and above verified; `full`: the
    /// whole review.
    #[arg(long, value_enum, default_value_t = Depth::Full)]
    pub depth: Depth,
    /// Start a new chain of review rounds: build on no earlier round of this branch.
    #[arg(long)]
    pub fresh: bool,
    /// Every this-many-th round of a branch's chain reviews the whole diff again rather than the
    /// fix commits since the prior round; 0, never.
    #[arg(long, default_value_t = 3)]
    pub full_every: u32,
    /// Where the earlier runs a re-review builds on are looked for; the run directory's parent
    /// (~/.craft/runs/cli by default) when absent.
    #[arg(long)]
    pub runs: Option<PathBuf>,
    /// Strict mode: a confirmed maintainability finding at Medium or above is a presumptive
    /// blocker, and the maintainability lens always runs.
    #[arg(long)]
    pub strict: bool,
    /// The launcher's own decision, question and rule records (`priorDecisions`), a JSON list, as
    /// a file or `-` for stdin; they add to what the run recalls from the project's memory.
    #[arg(long)]
    pub prior_decisions: Option<PathBuf>,
    /// Recall nothing from the project's memory: only the records `--prior-decisions` passes
    /// apply (a launcher that recalled them itself).
    #[arg(long)]
    pub no_recall: bool,
    /// Run no mechanical gate: clippy and `nix flake check` build the branch's code (build scripts,
    /// proc macros, flake checks run as you), so skip them for a branch you do not trust; the report
    /// names the gate as skipped.
    #[arg(long)]
    pub no_gate: bool,
    /// The repository's own reviewing agents to run as extra lenses, each over the whole change:
    /// their names, separated by commas or spaces, or `off`. Absent, a light pass discovers them
    /// among the agents the session's project declares under `.claude/agents` (when `--cwd` is that
    /// project or one of its worktrees) and a full review runs none.
    #[arg(long)]
    pub extra_lenses: Option<String>,
    /// Unit mode, experimental and off by default: each sliceable lens confined to a batch of the
    /// crates the change touches, a contract lens per touched crate, and a coordinator after the
    /// rounds that answers the lenses' questions about other crates and judges the seam between
    /// them; a change it cannot slice runs in the normal mode with a warning saying why.
    #[arg(long)]
    pub unit_scope: bool,
    /// Review only the change under this directory (or file) of the repository, as a crate of an
    /// audit is reviewed: repository-relative, or absolute inside the repository. A run of one
    /// path builds only on an earlier round of the same path.
    #[arg(long)]
    pub path: Option<String>,
    /// Publish the findings on the checked-out branch's pull request when the run finishes: the
    /// defects posted as review comments with `gh` (one already there with the craft-finding
    /// marker is not posted again), the doubtful ones listed in the report for the reviewer.
    #[arg(long)]
    pub comment: bool,
    /// The optional pass, off by default: `all`, or the optional lenses to run, separated by
    /// commas (`performance`, or qualified by its profile, `rust-performance`). A name that is no
    /// optional lens is named in the report; the recognised ones still run.
    #[arg(long, value_name = "all|lens,…")]
    pub optional: Option<String>,
    /// A parent engine launched this run (rust-audit's per-crate reviews): it builds on no earlier
    /// round of the branch and files no round record, so a later run of the same path reviews it
    /// whole again.
    #[arg(long)]
    pub nested: bool,
    /// File the run's telemetry under this craft version, as the cli-review engine's own run: a
    /// checkpoint as each phase ends and the run record when it finishes, through the plugin
    /// root's `lib/cli-review-file.mjs` and `node`. Absent, nothing is filed.
    #[arg(long, value_name = "CRAFT_VERSION")]
    pub record: Option<String>,
    /// The parent engine a nested run's record is filed under.
    #[arg(long, requires = "record")]
    pub via: Option<String>,
}

/// How deep a review goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum Depth {
    Full,
    Light,
}

#[derive(Debug, clap::Args)]
pub struct SubmitArgs {
    /// The run directory `start` printed.
    #[arg(long)]
    pub run: PathBuf,
    /// A JSON object of answers by task id, as a file or `-` for stdin, in place of the answer
    /// files the tasks' agents wrote under the run's `answers/`.
    #[arg(long)]
    pub answers: Option<PathBuf>,
    /// How the host ran this step's tasks weaker than asked (a task run without the agent it
    /// named); repeatable. Each is kept and named in the report and the finished step.
    #[arg(long)]
    pub degraded: Vec<String>,
    /// The account's usage limit, as an agent's error or short answer said it: the run keeps the
    /// answers that came in and stops, INCOMPLETE, with its unanswered tasks held; a later submit
    /// without it resumes the run once the limit resets.
    #[arg(long)]
    pub limit: Option<String>,
    /// The host resumes a run it lost (a stop it could not report, an interrupted host): an answer
    /// missing now is handed out again rather than counted as a failed attempt.
    #[arg(long)]
    pub resume: bool,
    /// A task whose agent the host abandoned at its deadline; repeatable. It fails at once and is
    /// not handed out again, and an answer its agent writes later is never read.
    #[arg(long)]
    pub abandoned: Vec<String>,
    /// For the run's telemetry (`start --record`): the task agents the host has dispatched so far.
    #[arg(long)]
    pub agents: Option<u64>,
    /// For the run's telemetry: the output tokens the host's run has spent so far.
    #[arg(long)]
    pub output_tokens: Option<u64>,
}

#[derive(Debug, clap::Args)]
pub struct StatusArgs {
    /// The run directory `start` printed.
    #[arg(long)]
    pub run: PathBuf,
}

fn print(value: &Value) -> Result<ExitCode> {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{}", serde_json::to_string(value)?)?;
    Ok(ExitCode::SUCCESS)
}

/// Whole milliseconds, saturated.
fn ms(d: std::time::Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

/// A step stamped with the wall clock the host has none of (the workflow sandbox reads no clock):
/// `at`, when it was printed, and `took`, how long this command ran, both in milliseconds, from
/// which the host tells its runtime figures apart by phase.
fn stamped(mut step: Value, began: Instant) -> Value {
    // 0 on a clock set before the epoch: the host then reads no wall time from it.
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(ms)
        .unwrap_or_default();
    if let Some(obj) = step.as_object_mut() {
        obj.insert("at".into(), Value::from(at));
        obj.insert("took".into(), Value::from(ms(began.elapsed())));
    }
    step
}

/// A fresh run directory under `~/.craft/runs/cli`, named by the time and this process.
fn default_run_dir() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").context("HOME is not set; pass --run-dir")?;
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    Ok(Path::new(&home)
        .join(".craft/runs/cli")
        .join(format!("{secs}-{}", std::process::id())))
}

pub fn start(args: &StartArgs) -> Result<ExitCode> {
    let began = Instant::now();
    let root = args.craft_root.clone().or_else(find_craft_root);
    let (craft_root, craft_version) = match root {
        Some(r) => match prompts::craft_root_near(&r) {
            Some((root, version)) => (Some(root), version),
            None => (Some(r.display().to_string()), None),
        },
        None => (None, None),
    };
    let run_dir = match &args.run_dir {
        Some(d) => d.clone(),
        None => default_run_dir()?,
    };
    let opts = step::StartOptions {
        cwd: args.cwd.clone(),
        base: args.base.clone(),
        run_dir: std::path::absolute(&run_dir)
            .with_context(|| format!("resolving {}", run_dir.display()))?,
        craft_root,
        craft_version,
        light: args.depth == Depth::Light,
        fresh: args.fresh,
        full_every: args.full_every,
        runs: args.runs.clone(),
        strict: args.strict,
        recall: !args.no_recall,
        // An unreadable list is refused and named in the report; the review still runs.
        prior_decisions: args
            .prior_decisions
            .as_deref()
            .map(|p| json_input(p).map_err(|e| format!("{e:#}"))),
        sources: crate::init::sources_setup(),
        gate: (!args.no_gate).then(craft_review::gate::GateSetup::default),
        extra_lenses: args.extra_lenses.clone(),
        session: None,
        unit_scope: args.unit_scope,
        path: args.path.clone(),
        comment: args.comment,
        optional: args.optional.clone(),
        nested: args.nested,
    };
    let step = stamped(step::start(&opts)?, began);
    match &args.record {
        Some(version) => print(&opened(&opts.run_dir, version, args.via.as_deref(), step)),
        None => print(&step),
    }
}

/// The harness session the host runs in, stamped on the run's telemetry.
fn session() -> String {
    std::env::var("CLAUDE_CODE_SESSION_ID").unwrap_or_default()
}

/// The started `step` with its telemetry opened: the start checkpoint written, and the record when
/// the run ended at once.
fn opened(run: &Path, version: &str, via: Option<&str>, step: Value) -> Value {
    let filing = match craft_review::state::load(run) {
        Ok(state) => {
            let ctx = filing::Ctx::of(&state, version, via.unwrap_or_default());
            filing::open(run, ctx, &session(), &step, &filing::NodeWriter)
        }
        Err(e) => {
            json!({"runDir": "", "rejoin": false, "lost": [format!("the run's telemetry — {e}")]})
        }
    };
    filing::with_filing(step, filing)
}

/// A JSON value the host passes, as a file or `-` for stdin.
fn json_input(path: &Path) -> Result<Value> {
    let text = if path.as_os_str() == "-" {
        let mut s = String::new();
        std::io::stdin()
            .read_to_string(&mut s)
            .context("reading stdin")?;
        s
    } else {
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?
    };
    serde_json::from_str(&text).with_context(|| format!("{} is not JSON", path.display()))
}

/// The answers a host passes itself (`--answers`), as a JSON object by task id.
fn given_answers(path: &Path) -> Result<Map<String, Value>> {
    serde_json::from_value(json_input(path)?).context("the answers are not a JSON object")
}

pub fn submit(args: &SubmitArgs) -> Result<ExitCode> {
    let began = Instant::now();
    let given = args.answers.as_deref().map(given_answers).transpose()?;
    let run = std::path::absolute(&args.run)
        .with_context(|| format!("resolving {}", args.run.display()))?;
    // A finished run whose record did not land is filed again rather than refused.
    if let Some(step) = args
        .resume
        .then(|| filing::refile(&run, &filing::NodeWriter))
        .flatten()
    {
        return print(&step);
    }
    let said = step::Said {
        degraded: &args.degraded,
        limit: args.limit.as_deref(),
        resume: args.resume,
        post: None,
        abandoned: &args.abandoned,
    };
    let step = stamped(step::submit_with(&run, given.as_ref(), &said)?, began);
    let host = filing::Host {
        agents: args.agents,
        output_tokens: args.output_tokens,
        resume: args.resume,
        session: session(),
    };
    match filing::submitted(&run, &step, &host, &filing::NodeWriter) {
        Some(filed) => print(&filing::with_filing(step, filed)),
        None => print(&step),
    }
}

pub fn status(args: &StatusArgs) -> Result<ExitCode> {
    print(&status::status(&args.run)?)
}
