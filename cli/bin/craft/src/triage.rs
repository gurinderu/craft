//! `craft triage start | submit | status`: the triage of review findings on the step protocol
//! (`craft_triage::step`; realm @nick/craft, node #616), each step printed as one JSON line; a
//! run started with `--record` files its record in the run store itself when it ends.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result};
use clap::Subcommand;
use craft_triage::run::{Args, Recording};
use craft_triage::step::{self, StartOptions};

use crate::filing_worker::BoundedWriter;
use crate::steps::{default_run_dir, filing_root, given_answers, json_input, print};

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
    /// File the run's record under this craft version, as the triage engine's own run: written
    /// into the run store (`~/.craft/runs`) by the binary itself when the run ends. Absent,
    /// nothing is filed.
    #[arg(long, value_name = "CRAFT_VERSION")]
    pub record: Option<String>,
    /// The craft plugin root the record is stamped with (`craftCommit`), when it is not the one
    /// above the binary.
    #[arg(long, requires = "record")]
    pub record_root: Option<PathBuf>,
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
            step::submit(
                &absolute(&a.run)?,
                given.as_ref(),
                &a.degraded,
                &BoundedWriter,
            )?
        }
        TriageCommand::Status(a) => step::status(&absolute(&a.run)?)?,
    })
}

/// `p` made absolute, so the files a step names are found from wherever its agents run.
fn absolute(p: &Path) -> Result<PathBuf> {
    std::path::absolute(p).with_context(|| format!("resolving {}", p.display()))
}

/// Refuses two inputs read from stdin: the second would read it empty.
fn one_stdin(a: &StartArgs) -> Result<()> {
    let stdin = |p: &Option<PathBuf>| p.as_deref().is_some_and(|p| p.as_os_str() == "-");
    if stdin(&a.prior_ledger) && stdin(&a.prior_decisions) {
        anyhow::bail!("--prior-ledger and --prior-decisions cannot both be read from stdin (-)");
    }
    Ok(())
}

fn start(a: &StartArgs) -> Result<serde_json::Value> {
    one_stdin(a)?;
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
        craft_version: a
            .record
            .clone()
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").into()),
        record: a.record.as_ref().map(|_| Recording {
            root: filing_root(a.record_root.as_deref()).unwrap_or_default(),
            session: std::env::var("CLAUDE_CODE_SESSION_ID").unwrap_or_default(),
        }),
    };
    let run_dir = absolute(&run_dir)?;
    Ok(step::start(
        &StartOptions {
            cwd: a.cwd.clone(),
            run_dir,
            args,
        },
        &BoundedWriter,
    )?)
}
