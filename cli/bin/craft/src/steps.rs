//! `craft review start | submit | status`: the step protocol (realm @nick/craft, node #453) on the
//! command line. Each prints one JSON value on stdout; an error is one line on stderr and a
//! non-zero exit (`main`).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use craft_review::{prompts, status, step};
use serde_json::{Map, Value};

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
        prior_decisions: args
            .prior_decisions
            .as_deref()
            .map(json_input)
            .transpose()?,
    };
    print(&step::start(&opts)?)
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
    let given = args.answers.as_deref().map(given_answers).transpose()?;
    let run = std::path::absolute(&args.run)
        .with_context(|| format!("resolving {}", args.run.display()))?;
    print(&step::submit_noting(&run, given.as_ref(), &args.degraded)?)
}

pub fn status(args: &StatusArgs) -> Result<ExitCode> {
    print(&status::status(&args.run)?)
}
