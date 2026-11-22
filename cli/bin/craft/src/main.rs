//! `craft`: the command line over craft's review.

mod comment;
mod filing_worker;
mod hook;
mod init;
mod memory;
mod post;
mod pr;
mod printed;
mod process_identity;
mod review;
mod run;
mod runs;
mod scratch;
mod settle;
mod steps;

use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand, ValueEnum};

#[derive(Parser)]
#[command(version, about = "craft's review, run from the command line")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Review the changes between a base and HEAD, step by step: each step prints the agents the
    /// host is to run, and the next takes their answers.
    #[command(subcommand)]
    Review(ReviewCommand),
    /// Your review profile of a repository, kept outside it (`~/.craft/projects/<id>/review.toml`):
    /// the integration points whose source a review reads at their deployed revision.
    Init(init::InitArgs),
    /// craft's hooks that run as this binary, each reading the harness's hook input on stdin.
    #[command(subcommand)]
    Hook(HookCommand),
    /// The run store (`~/.craft/runs`): list its runs, show one, sum them, check the store, a
    /// version's retro.
    Runs(runs::RunsArgs),
    /// craft's records in the harness's project memory: its own index beside `MEMORY.md`.
    #[command(subcommand)]
    Memory(memory::MemoryCommand),
    /// A pull request's review threads read with `gh`.
    #[command(subcommand)]
    Pr(pr::PrCommand),
    #[command(name = "__craft-file-run", hide = true)]
    FileRun,
    #[command(name = "__craft-process-identity", hide = true)]
    ProcessIdentity(process_identity::Args),
}

#[derive(Subcommand)]
enum HookCommand {
    /// After a Bash call opened a pull request: say when the run store holds no finished full
    /// craft review of its head. Prints the `PostToolUse` output or nothing, and always exits 0.
    PrOpened(hook::PrOpenedArgs),
    /// At a session's start: what the repo's declared roles or work rules mean for craft's tools.
    /// Prints the `SessionStart` output or nothing, and always exits 0.
    SessionStart,
    /// On a human's prompt asking for review work: how to run it with craft's tools. Prints the
    /// `UserPromptSubmit` output or nothing, and always exits 0.
    UserPrompt,
    /// To a subagent of a session that asked for review work: its part. Prints the
    /// `SubagentStart` output or nothing, and always exits 0.
    SubagentStart,
    /// When the main session dispatches the repo's own reviewer agent: run craft's review beside
    /// it. Prints the `PreToolUse` output or nothing, never blocks, and always exits 0.
    ReviewerDispatch,
    /// The OpenCode plugin's work hook on one user message: prints the lines to add, or nothing,
    /// and always exits 0.
    OpencodeMessage,
    /// The OpenCode plugin's work hook on a session's compaction: logs it, prints nothing.
    OpencodeCompacted,
}

#[derive(Subcommand)]
enum ReviewCommand {
    /// Open a run: compute the diff and print the first tasks.
    Start(Box<steps::StartArgs>),
    /// Hand in the answers to a run's pending tasks and print what comes next.
    Submit(steps::SubmitArgs),
    /// Print where a run stands.
    Status(steps::StatusArgs),
    /// Publish a finished run's findings on its branch's pull request, as `start --comment` does
    /// when the run finishes: the defects posted with `gh`, the doubtful ones listed in the report.
    Comment(comment::CommentArgs),
    /// Post one doubtful finding the reviewer chose, read by its number from the review run's
    /// record, on the pull request — as a question to the author or as a defect — with the
    /// craft-finding marker, and record the choice in that record.
    Post(post::PostArgs),
    /// Run only the mechanical gate over the change and print how it came out: no run, no lens,
    /// no record (rust-audit's one gate for a workspace whose crates it reviews with `--no-gate`).
    Gate(steps::GateArgs),
    /// Run one probe agent end to end through a backend, with the progress view.
    Probe(ReviewArgs),
    /// Run the whole review in one command: the binary drives its steps itself, each task run as
    /// its own process of the host's CLI (`codex exec`, `pi -p`, `opencode run`), and prints the verdict.
    Run(Box<run::RunArgs>),
}

/// Which way an agent is run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum Backend {
    /// The `claude` CLI, one subprocess per agent.
    ClaudeCode,
    /// The Anthropic API directly (not implemented yet).
    AnthropicApi,
}

#[derive(Debug, clap::Args)]
pub struct ReviewArgs {
    /// The repository to review.
    #[arg(long, default_value = ".")]
    pub cwd: PathBuf,
    /// What the changes are measured against.
    #[arg(long, default_value = "origin/main")]
    pub base: String,
    #[arg(long, value_enum, default_value_t = Backend::ClaudeCode)]
    pub backend: Backend,
    /// Where the result goes as JSON; stdout when absent.
    #[arg(long)]
    pub out: Option<PathBuf>,
    /// At most this many agents at once.
    #[arg(long, default_value = "4")]
    pub concurrency: NonZeroUsize,
    /// One line per event instead of the live view (the default when stderr is not a terminal).
    #[arg(long)]
    pub plain: bool,
    /// An agent spec as JSON; the built-in probe agent when absent.
    #[arg(long)]
    pub spec: Option<PathBuf>,
    /// craft's plugin root, loaded by every agent; found above the executable when absent.
    #[arg(long, env = "CRAFT_ROOT")]
    pub craft_root: Option<PathBuf>,
    /// The `claude` CLI to run.
    #[arg(long, default_value = "claude")]
    pub claude: PathBuf,
}

#[tokio::main]
async fn main() -> ExitCode {
    let outcome = dispatch().await;
    finish(outcome).await
}

async fn dispatch() -> anyhow::Result<ExitCode> {
    let cli = Cli::parse();
    match cli.command {
        Command::Review(ReviewCommand::Probe(args)) => review::run(args).await,
        Command::Review(ReviewCommand::Start(args)) => steps::start(&args),
        Command::Review(ReviewCommand::Submit(args)) => steps::submit(&args),
        Command::Review(ReviewCommand::Status(args)) => steps::status(&args),
        Command::Review(ReviewCommand::Comment(args)) => comment::comment(&args),
        Command::Review(ReviewCommand::Post(args)) => post::post(&args),
        Command::Review(ReviewCommand::Gate(args)) => steps::gate(&args),
        Command::Review(ReviewCommand::Run(args)) => run::run(*args).await,
        Command::Init(args) => init::init(&args),
        Command::Hook(HookCommand::PrOpened(args)) => hook::pr_opened(&args),
        Command::Runs(args) => runs::runs(&args),
        Command::Memory(cmd) => memory::memory(&cmd),
        Command::Pr(cmd) => pr::pr(&cmd),
        Command::FileRun => filing_worker::worker(),
        Command::ProcessIdentity(args) => process_identity::run(&args),
        Command::Hook(HookCommand::SessionStart) => hook::role_hook(hook::RoleHook::SessionStart),
        Command::Hook(HookCommand::UserPrompt) => hook::role_hook(hook::RoleHook::UserPrompt),
        Command::Hook(HookCommand::SubagentStart) => hook::role_hook(hook::RoleHook::SubagentStart),
        Command::Hook(HookCommand::ReviewerDispatch) => {
            hook::role_hook(hook::RoleHook::ReviewerDispatch)
        }
        Command::Hook(HookCommand::OpencodeMessage) => {
            hook::role_hook(hook::RoleHook::OpencodeMessage)
        }
        Command::Hook(HookCommand::OpencodeCompacted) => {
            hook::role_hook(hook::RoleHook::OpencodeCompacted)
        }
    }
}

async fn finish(outcome: anyhow::Result<ExitCode>) -> ExitCode {
    finish_with(outcome, &settle::EXIT).await
}

async fn finish_with(outcome: anyhow::Result<ExitCode>, exit: &settle::Exit) -> ExitCode {
    // The outcome is reported first, so a settle that panicked cannot swallow its error.
    let code = report(outcome);
    // Every way out — a stop, an error, a finished run — waits out the grace of the agents'
    // groups, so their SIGKILL is sent before craft is gone.
    exit.wait().await;
    code
}

fn report(outcome: anyhow::Result<ExitCode>) -> ExitCode {
    match outcome {
        Ok(code) => code,
        Err(e) => {
            #[expect(clippy::print_stderr, reason = "the top-level error report of a CLI")]
            {
                eprintln!("craft: {e:#}");
            }
            // A refused argument exits as clap's own usage errors do, so a host tells it from a
            // failure (realm @nick/craft, node #523).
            let refused = e
                .downcast_ref::<craft_review::Error>()
                .is_some_and(craft_review::Error::refuses_argument);
            if refused {
                ExitCode::from(2)
            } else {
                ExitCode::FAILURE
            }
        }
    }
}

#[cfg(test)]
#[path = "main_tests.rs"]
mod tests;
