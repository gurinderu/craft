//! `craft audit start | submit | status`: the audit of a whole project on the step protocol
//! (`craft_audit::step`; realm @nick/craft, node #588), each step printed as one JSON line; a run
//! started with `--record` files its record in the run store itself when a pass ends.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result};
use clap::Subcommand;
use craft_audit::state::{Args, Recording};
use craft_audit::step::{self, StartOptions};

use crate::filing_worker::BoundedWriter;
use crate::steps::{default_run_dir, filing_root, given_answers, print, session};

mod args;

pub use args::{StartArgs, StatusArgs, SubmitArgs};

#[derive(Subcommand)]
pub enum AuditCommand {
    /// Open an audit: list the project's tracked files and print the lens agents its first pass
    /// buys.
    Start(StartArgs),
    /// Hand in the answers to an audit's pending tasks and print what comes next; `--resume` on a
    /// finished audit reads the files it left unread.
    Submit(SubmitArgs),
    /// Print where an audit stands.
    Status(StatusArgs),
}

pub fn audit(cmd: &AuditCommand) -> Result<ExitCode> {
    match cmd {
        AuditCommand::Start(a) => print(&step::start(&options(a)?, &BoundedWriter)?),
        AuditCommand::Submit(a) => print(&submit(a)?),
        AuditCommand::Status(a) => print(&step::status(&absolute(&a.run)?)?),
    }
}

fn submit(a: &SubmitArgs) -> Result<serde_json::Value> {
    let given = a.answers.as_deref().map(given_answers).transpose()?;
    let said = step::Said {
        degraded: &a.degraded,
        limit: a.limit.as_deref(),
        resume: a.resume,
        abandoned: &a.abandoned,
    };
    Ok(step::submit(
        &absolute(&a.run)?,
        given.as_ref(),
        &said,
        &BoundedWriter,
    )?)
}

/// `p` made absolute, so the files a step names are found from wherever its agents run.
fn absolute(p: &Path) -> Result<PathBuf> {
    std::path::absolute(p).with_context(|| format!("resolving {}", p.display()))
}

/// The craft plugin root the prompts name the skills under: the one given, else the one above
/// this binary.
fn craft_root(given: Option<&Path>) -> Option<String> {
    let root = given
        .map(Path::to_path_buf)
        .or_else(crate::review::find_craft_root)?;
    Some(match craft_review::prompts::craft_root_near(&root) {
        Some((found, _)) => found,
        None => root.display().to_string(),
    })
}

fn options(a: &StartArgs) -> Result<StartOptions> {
    let run_dir = match &a.run_dir {
        Some(d) => d.clone(),
        None => default_run_dir()?,
    };
    let args = Args {
        paths: a.path.clone(),
        batch_bytes: a.batch_bytes.get(),
        lens_agents: a.lens_agents.map(std::num::NonZeroUsize::get),
        craft_version: a
            .record
            .clone()
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").into()),
        craft_root: craft_root(a.craft_root.as_deref()),
        record: a.record.as_ref().map(|_| Recording {
            root: filing_root(a.record_root.as_deref()).unwrap_or_default(),
            session: session(),
        }),
    };
    Ok(StartOptions {
        cwd: a.cwd.clone(),
        run_dir: absolute(&run_dir)?,
        args,
    })
}
