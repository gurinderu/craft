//! `craft review run --backend codex|pi|opencode`: the whole review in one command, the binary
//! itself driving its step protocol (realm @nick/craft, nodes #453, #499) — each task run as its
//! own process of the host's CLI, under one concurrency limit, the answers handed in, until the
//! verdict. Progress goes to stderr, as lines or, with `--events json`, as events (#506); the
//! answer — the `## Verdict` block — to stdout. It exits 0 on a run whose work was whole (or that
//! had nothing to review), 1 on one cut short or stopped, 2 on an argument or a host refused
//! before anything ran.

mod args;
#[cfg(test)]
mod blocked_tests;
mod deadline;
mod delegate;
mod drive;
#[cfg(test)]
mod drive_tests;
mod ending;
mod events;
mod findings;
mod host;
mod limit;
mod models;
mod opencode;
mod outcome;
mod prepare;
mod protocol;
mod report;
mod round;
mod task;
mod telemetry;
mod there;
mod watch;

// The workspace's one way to write an executable a test then runs.
#[cfg(test)]
#[path = "../../../../test-support/exe.rs"]
mod exe;

use std::io::Write;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use crate::steps::StartArgs;
use anyhow::Result;
use args::{concurrency_of, host_of, root_of};
use clap::ValueEnum;
use drive::Driver;
use events::{Event, Sink};
use host::Host;
use protocol::InProcess;
use round::RoundCtx;

/// The host CLI a review's tasks run in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum HostKind {
    /// `codex exec`, read-only and ephemeral, one per task.
    Codex,
    /// `pi -p`, isolated and with read-only tools, one per task.
    Pi,
    /// Craft's read-only agents: one `opencode run` per task, or a child session with `--delegate`.
    #[value(name = "opencode")]
    OpenCode,
}

/// How progress is written to stderr.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum EventFormat {
    /// One JSON object per line (`events::Event`).
    Json,
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
    /// At most this many task processes at once, 1 to 16; absent, `CRAFT_<HOST>_CONCURRENCY`
    /// (`CODEX`, `PI`, `OPENCODE`), else 4.
    #[arg(long, value_parser = clap::value_parser!(u8).range(1..=16))]
    pub concurrency: Option<u8>,
    /// The host's model for the binary's Claude tiers: one name for every tier, or
    /// `opus=<model>,sonnet=<model>,haiku=<model>` (any of them; opencode's as
    /// `provider/model`); absent, `CRAFT_<HOST>_MODELS`, else the host's own configured model.
    #[arg(long)]
    pub models: Option<String>,
    /// pi only: how hard each tier's model thinks — one level for every tier, or
    /// `opus=<level>,sonnet=<level>,haiku=<level>` (any of them), a level one of off, minimal,
    /// low, medium, high, xhigh, max; absent, `CRAFT_PI_THINKING`, else opus high, sonnet medium,
    /// haiku low. A model `--models` names with its own `:<level>` keeps it.
    #[arg(long)]
    pub thinking: Option<String>,
    /// The host CLI to run; absent, `CRAFT_<HOST>_BIN`, else `codex`, `pi` or `opencode` on the
    /// PATH.
    #[arg(long)]
    pub host_bin: Option<PathBuf>,
    /// Progress as events on stderr rather than lines: `json`, one object per line.
    #[arg(long, value_enum)]
    pub events: Option<EventFormat>,
    /// opencode only, with `--events json`: hand each task to the process that runs this command
    /// as a `task` event and read its reply from stdin, one JSON line `{"key":n,"text":…}` or
    /// `{"key":n,"error":…}` — the OpenCode plugin runs each as a child session. No `opencode`
    /// is run.
    #[arg(long)]
    pub delegate: bool,
    /// With `--delegate`: the agents the delegating OpenCode lists, comma-separated. Without
    /// `review-task` the review refuses; a task whose own agent is not listed runs on
    /// `review-task`, said degraded.
    #[arg(long, requires = "delegate")]
    pub agents: Option<String>,
}

fn say(out: &mut dyn Write, text: &str) -> Result<()> {
    writeln!(out, "{text}")?;
    Ok(())
}

/// A refusal before anything ran: its answer and the last event, exit 2.
fn refused(sink: Sink, why: &str) -> Result<ExitCode> {
    say(
        &mut std::io::stdout().lock(),
        &report::stopped_answer(&format!("review: {why}. Nothing ran.")),
    )?;
    sink.emit(&Event::result(None, None, 2));
    Ok(ExitCode::from(2))
}

/// The host and what it runs with, or why it cannot be used: opencode is asked first which
/// agents it has — or, with `--delegate`, takes those `--agents` names and runs no opencode.
fn ready(args: &RunArgs, repo: &Path, sink: Sink) -> Result<(NonZeroUsize, Host, PathBuf), String> {
    let (concurrency, mut host, root) =
        concurrency_of(args).and_then(|c| Ok((c, host_of(args)?, root_of(args)?)))?;
    if args.delegate {
        if host.kind != HostKind::OpenCode || !sink.json {
            return Err("--delegate is opencode's alone, with --events json".into());
        }
        host.agents = Some(opencode::delegated(args.agents.as_deref())?);
        host.delegate = Some(delegate::Delegate::on_stdin(
            move |e| sink.emitted(&e),
            move |l| sink.log(l),
        ));
        return Ok((concurrency, host, root));
    }
    if host.kind == HostKind::OpenCode {
        let ready = opencode::preflight(&host.command, repo, &|l| sink.log(l))?;
        (host.agents, host.archived) = (ready.agents, ready.archived);
    }
    Ok((concurrency, host, root))
}

pub async fn run(mut args: RunArgs) -> Result<ExitCode> {
    // Before the stop handler: a signal then ends an input held open, which no handler could
    // interrupt (realm @nick/craft, node #737).
    if args.run.is_none() {
        args.start.prior_decisions_read = crate::steps::prior_decisions(&args.start);
    }
    // Before any task starts, so no stopping signal finds craft without a handler while a task's
    // process group is up: the round in flight stops its tasks, and the run is filed INCOMPLETE
    // with how to resume it (realm @nick/craft, node #40).
    let signal = crate::review::stop_signal();
    let (stopping, stop) = tokio::sync::watch::channel(None);
    tokio::spawn(async move {
        if let Some(code) = signal.await {
            let _gone = stopping.send(Some(code));
        }
    });
    let sink = Sink {
        json: args.events == Some(EventFormat::Json),
    };
    if args.run.is_some() && args.start.all_lenses {
        // A resume keeps the lenses its start chose: the flag would read as taken and not be.
        return refused(
            sink,
            "--all-lenses goes with a start: a resumed run keeps the lenses it started with",
        );
    }
    let repo = std::path::absolute(&args.start.cwd)?;
    let (concurrency, host, root) = match ready(&args, &repo, sink) {
        Ok(s) => s,
        Err(why) => return refused(sink, &why),
    };
    let comment = args.start.comment;
    let mut start = args.start;
    start
        .record
        .get_or_insert_with(|| env!("CARGO_PKG_VERSION").to_owned());
    start.craft_root = Some(root.clone());
    start.runtime = args
        .backend
        .to_possible_value()
        .map(|v| v.get_name().to_owned());
    let log = |line: &str| sink.log(line);
    let emit = |event: Event| sink.emit(&event);
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
            emit: &emit,
            stop: stop.clone(),
        },
        again: &again,
    };
    let answer = ending::drive(&driver, args.run.as_deref().map(Path::new), comment).await;
    say(&mut std::io::stdout().lock(), &answer.text)?;
    let code = (*stop.borrow()).unwrap_or(u8::from(!answer.finished));
    sink.emit(&Event::result(answer.step.as_ref(), answer.run, code));
    Ok(ExitCode::from(code))
}
