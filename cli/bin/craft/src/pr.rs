//! `craft pr rejections`: the PR author's and maintainers' rejections of review findings, read from
//! the pull request's review threads with `gh` (or from a saved `gh api graphql` answer), printed as
//! `{ decisions, skipped }` — each decision a memory record ready for `record-decision`.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Context, Result};
use craft_review::publish::PostSetup;
use craft_review::rejections::{self, fetch};
use serde_json::Value;

#[derive(Debug, clap::Subcommand)]
pub enum PrCommand {
    /// The rejections of review findings in a pull request's review threads, as decision records:
    /// `{ decisions, skipped }` as JSON. Exits 2 when the threads cannot be read.
    Rejections(RejectionsArgs),
}

#[derive(Debug, clap::Args)]
pub struct RejectionsArgs {
    /// The pull request, by number; the checked-out branch's when absent.
    #[arg(long)]
    pub pr: Option<u64>,
    /// The repository, `<owner>/<name>`; the checkout's when absent.
    #[arg(long)]
    pub repo: Option<String>,
    /// A saved `gh api graphql` reviewThreads answer (or a slurped array of its pages), `-` for
    /// stdin, read in place of asking gh.
    #[arg(long, conflicts_with_all = ["pr", "repo"])]
    pub threads: Option<PathBuf>,
}

/// Says why on stderr and exits 2: nothing could be read, so nothing is to be recorded.
fn unreadable(why: &str) -> ExitCode {
    drop(writeln!(
        std::io::stderr().lock(),
        "craft pr rejections: {why}"
    ));
    ExitCode::from(2)
}

fn saved(path: &std::path::Path) -> Result<String> {
    let mut text = String::new();
    if path.as_os_str() == "-" {
        std::io::stdin()
            .read_to_string(&mut text)
            .context("reading stdin")?;
    } else {
        text =
            std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    }
    Ok(text)
}

pub fn pr(cmd: &PrCommand) -> Result<ExitCode> {
    let PrCommand::Rejections(args) = cmd;
    let answer: Value = if let Some(path) = &args.threads {
        let text = match saved(path) {
            Ok(t) => t,
            Err(e) => return Ok(unreadable(&format!("{e:#}"))),
        };
        match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(e) => return Ok(unreadable(&format!("cannot read {}: {e}", path.display()))),
        }
    } else {
        let cwd = match std::env::current_dir() {
            Ok(d) => d,
            Err(e) => return Ok(unreadable(&format!("reading the working directory: {e}"))),
        };
        let scratch = crate::scratch::dir("craft-pr")?;
        let which = fetch::Which {
            pr: args.pr,
            repo: args.repo.as_deref(),
        };
        let got = fetch::answer(&cwd, &which, &PostSetup::default(), &scratch);
        drop(std::fs::remove_dir_all(&scratch));
        match got {
            Ok(v) => v,
            Err(e) => return Ok(unreadable(&e.to_string())),
        }
    };
    match rejections::from_answer(&answer) {
        Ok(r) => {
            writeln!(
                std::io::stdout().lock(),
                "{}",
                serde_json::to_string_pretty(&r)?
            )?;
            Ok(ExitCode::SUCCESS)
        }
        Err(e) => Ok(unreadable(&e.to_string())),
    }
}
