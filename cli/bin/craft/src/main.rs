//! `craft`: the command line over craft's review.

mod init;
mod review;
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
}

#[derive(Subcommand)]
enum ReviewCommand {
    /// Open a run: compute the diff and print the first tasks.
    Start(Box<steps::StartArgs>),
    /// Hand in the answers to a run's pending tasks and print what comes next.
    Submit(steps::SubmitArgs),
    /// Print where a run stands.
    Status(steps::StatusArgs),
    /// Run only the mechanical gate over the change and print how it came out: no run, no lens,
    /// no record (rust-audit's one gate for a workspace whose crates it reviews with `--no-gate`).
    Gate(steps::GateArgs),
    /// Run one probe agent end to end through a backend, with the progress view.
    Probe(ReviewArgs),
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
    let cli = Cli::parse();
    let outcome = match cli.command {
        Command::Review(ReviewCommand::Probe(args)) => review::run(args).await,
        Command::Review(ReviewCommand::Start(args)) => steps::start(&args),
        Command::Review(ReviewCommand::Submit(args)) => steps::submit(&args),
        Command::Review(ReviewCommand::Status(args)) => steps::status(&args),
        Command::Review(ReviewCommand::Gate(args)) => steps::gate(&args),
        Command::Init(args) => init::init(&args),
    };
    // Every way out — a stop, an error, a finished run — waits out the grace of the agents'
    // groups, so their SIGKILL is sent before craft is gone.
    if let Err(e) = tokio::task::spawn_blocking(craft_agent::settle_stops).await {
        std::panic::resume_unwind(e.into_panic());
    }
    match outcome {
        Ok(code) => code,
        Err(e) => {
            #[expect(clippy::print_stderr, reason = "the top-level error report of a CLI")]
            {
                eprintln!("craft: {e:#}");
            }
            ExitCode::FAILURE
        }
    }
}
