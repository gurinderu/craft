//! `craft review run --backend codex|pi`: the whole review in one command, the binary itself
//! driving its step protocol (realm @nick/craft, nodes #453, #499) — each task run as its own
//! process of the host's CLI, under one concurrency limit, the answers handed in, until the
//! verdict. Progress goes to stderr; the answer — the `## Verdict` block — to stdout. It exits 0
//! on a run whose work was whole (or that had nothing to review), 1 on one cut short or stopped,
//! 2 on an argument refused before anything ran.

mod args;
mod deadline;
mod drive;
#[cfg(test)]
mod drive_tests;
mod ending;
mod host;
mod limit;
mod models;
mod outcome;
mod protocol;
mod report;
mod round;
mod task;
mod telemetry;

// The workspace's one way to write an executable a test then runs.
#[cfg(test)]
#[path = "../../../../test-support/exe.rs"]
mod exe;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use crate::steps::StartArgs;
use anyhow::Result;
use args::{concurrency_of, host_of, root_of};
use clap::ValueEnum;
use drive::Driver;
use protocol::InProcess;
use round::RoundCtx;

/// The host CLI a review's tasks run in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum HostKind {
    /// `codex exec`, read-only and ephemeral, one per task.
    Codex,
    /// `pi -p`, isolated and with read-only tools, one per task.
    Pi,
}

#[derive(Debug, clap::Args)]
pub struct RunArgs {
    /// The host CLI each task runs in; its login is the host's own.
    #[arg(long, value_enum)]
    pub backend: HostKind,
    #[command(flatten)]
    pub start: StartArgs,
    /// Resume the run in this directory rather than start one — or, with `--comment`, publish
    /// that finished run on its pull request.
    #[arg(long, conflicts_with = "run_dir")]
    pub run: Option<PathBuf>,
    /// At most this many task processes at once, 1 to 16; absent, `CRAFT_CODEX_CONCURRENCY` or
    /// `CRAFT_PI_CONCURRENCY`, else 4.
    #[arg(long, value_parser = clap::value_parser!(u8).range(1..=16))]
    pub concurrency: Option<u8>,
    /// The host's model for the binary's Claude tiers: one name for every tier, or
    /// `opus=<model>,sonnet=<model>,haiku=<model>` (any of them); absent, `CRAFT_CODEX_MODELS` or
    /// `CRAFT_PI_MODELS`, else the host's own configured model.
    #[arg(long)]
    pub models: Option<String>,
    /// The host CLI to run; absent, `CRAFT_CODEX_BIN` or `CRAFT_PI_BIN`, else `codex` or `pi` on
    /// the PATH.
    #[arg(long)]
    pub host_bin: Option<PathBuf>,
}

fn say(out: &mut dyn Write, text: &str) -> Result<()> {
    writeln!(out, "{text}")?;
    Ok(())
}

/// The progress line on stderr; a failed write loses only progress.
fn log(line: &str) {
    let _unlogged = writeln!(std::io::stderr().lock(), "{line}");
}

pub async fn run(args: RunArgs) -> Result<ExitCode> {
    let set = concurrency_of(&args).and_then(|c| Ok((c, host_of(&args)?, root_of(&args)?)));
    let (concurrency, host, root) = match set {
        Ok(s) => s,
        Err(why) => {
            say(
                &mut std::io::stdout().lock(),
                &report::stopped_answer(&format!("review: {why}. Nothing ran.")),
            )?;
            return Ok(ExitCode::from(2));
        }
    };
    let comment = args.start.comment;
    let mut start = args.start;
    start
        .record
        .get_or_insert_with(|| env!("CARGO_PKG_VERSION").to_owned());
    start.craft_root = Some(root.clone());
    let repo = std::path::absolute(&start.cwd)?;
    log(&format!(
        "review {} in {}: {} over {}, up to {concurrency} task(s) at once",
        env!("CARGO_PKG_VERSION"),
        host.name(),
        host.command.display(),
        repo.display()
    ));
    let backend = args.backend;
    let again = move |run: &str| {
        let name = backend
            .to_possible_value()
            .map(|v| v.get_name().to_owned())
            .unwrap_or_default();
        format!(
            "this command again, `craft review run --backend {name} --run '{}'`",
            run.replace('\'', r"'\''")
        )
    };
    let proto = InProcess {
        start,
        record_root: root.clone(),
    };
    let driver = Driver {
        proto: &proto,
        round: RoundCtx {
            host: &host,
            root: &root,
            repo: &repo,
            concurrency,
            deadline: None,
            log: &log,
        },
        again: &again,
    };
    let answer = ending::drive(&driver, args.run.as_deref().map(Path::new), comment).await;
    say(&mut std::io::stdout().lock(), &answer.text)?;
    Ok(if answer.finished {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    })
}
