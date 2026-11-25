//! `craft triage start | submit | status`: the triage of review findings on the step protocol
//! (`craft_triage::step`; realm @nick/craft, node #616), each step printed as one JSON line.

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Context, Result};
use clap::Subcommand;
use craft_triage::run::Args;
use craft_triage::step::{self, StartOptions};

use crate::steps::{default_run_dir, given_answers, json_input, print};

#[derive(Subcommand)]
pub enum TriageCommand {
    /// Open a triage: print the gatherers of the sources named.
    Start(StartArgs),
    /// Hand in the answers to a triage's pending tasks and print what comes next.
    Submit(SubmitArgs),
    /// Print where a triage stands.
    Status(StatusArgs),
}

#[derive(Debug, clap::Args)]
pub struct StartArgs {
    /// The checkout the session runs in.
    #[arg(long, default_value = ".")]
    pub cwd: PathBuf,
    /// Where the triage keeps its state; a new directory under ~/.craft/runs/cli when absent.
    #[arg(long)]
    pub run_dir: Option<PathBuf>,
    /// A report file of any review engine to gather the findings from.
    #[arg(long, default_value = "")]
    pub report: String,
    /// A pull request whose review threads to gather the findings from.
    #[arg(long, default_value = "")]
    pub pr: String,
    /// The ref the findings were generated against (the reviewed head); the validators read it.
    #[arg(long, default_value = "")]
    pub base: String,
    /// The commit the PR forks from, where "not this PR's" must be shown.
    #[arg(long, default_value = "")]
    pub pr_base: String,
    /// The repository the findings are in, when it is not the one `--cwd` names.
    #[arg(long, default_value = "")]
    pub repo: String,
    /// A prior ledger (a JSON list of `{stable_id, verdict, reason}`), as a file or `-`.
    #[arg(long)]
    pub prior_ledger: Option<PathBuf>,
    /// The launcher's records (`priorDecisions`), as a file or `-`.
    #[arg(long)]
    pub prior_decisions: Option<PathBuf>,
}

#[derive(Debug, clap::Args)]
pub struct SubmitArgs {
    /// The triage's run directory.
    #[arg(long)]
    pub run: PathBuf,
    /// The answers as one JSON object by task id; read from the answer files when absent.
    #[arg(long)]
    pub answers: Option<PathBuf>,
    /// How the host ran this step's tasks weaker than asked, one note each.
    #[arg(long)]
    pub degraded: Vec<String>,
}

#[derive(Debug, clap::Args)]
pub struct StatusArgs {
    /// The triage's run directory.
    #[arg(long)]
    pub run: PathBuf,
}

pub fn triage(cmd: &TriageCommand) -> Result<ExitCode> {
    print(&match cmd {
        TriageCommand::Start(a) => start(a)?,
        TriageCommand::Submit(a) => {
            let given = a.answers.as_deref().map(given_answers).transpose()?;
            step::submit(&a.run, given.as_ref(), &a.degraded)?
        }
        TriageCommand::Status(a) => step::status(&a.run)?,
    })
}

fn start(a: &StartArgs) -> Result<serde_json::Value> {
    if a.report.is_empty() && a.pr.is_empty() {
        anyhow::bail!("a triage needs a source: --report <file> and/or --pr <number>");
    }
    let run_dir = match &a.run_dir {
        Some(d) => d.clone(),
        None => default_run_dir()?,
    };
    let prior_ledger = match &a.prior_ledger {
        Some(p) => {
            serde_json::from_value(json_input(p)?).context("the prior ledger is not a JSON list")?
        }
        None => Vec::new(),
    };
    let args = Args {
        report: a.report.clone(),
        pr: a.pr.clone(),
        base: a.base.clone(),
        pr_base: a.pr_base.clone(),
        repo: a.repo.clone(),
        prior_ledger,
        prior_decisions: a
            .prior_decisions
            .as_deref()
            .map(|p| json_input(p).map_err(|e| format!("{e:#}"))),
        craft_version: env!("CARGO_PKG_VERSION").into(),
    };
    let run_dir = std::path::absolute(&run_dir)
        .with_context(|| format!("resolving {}", run_dir.display()))?;
    Ok(step::start(&StartOptions {
        cwd: a.cwd.clone(),
        run_dir,
        args,
    })?)
}
