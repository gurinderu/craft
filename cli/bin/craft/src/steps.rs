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
}

#[derive(Debug, clap::Args)]
pub struct SubmitArgs {
    /// The run directory `start` printed.
    #[arg(long)]
    pub run: PathBuf,
    /// A JSON object of answers by task id, as a file or `-` for stdin.
    #[arg(long)]
    pub answers: PathBuf,
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
    };
    print(&step::start(&opts)?)
}

pub fn submit(args: &SubmitArgs) -> Result<ExitCode> {
    let text = if args.answers.as_os_str() == "-" {
        let mut s = String::new();
        std::io::stdin()
            .read_to_string(&mut s)
            .context("reading the answers from stdin")?;
        s
    } else {
        std::fs::read_to_string(&args.answers)
            .with_context(|| format!("reading the answers {}", args.answers.display()))?
    };
    let answers: Map<String, Value> =
        serde_json::from_str(&text).context("the answers are not a JSON object")?;
    print(&step::submit(&args.run, &answers)?)
}

pub fn status(args: &StatusArgs) -> Result<ExitCode> {
    print(&status::status(&args.run)?)
}
