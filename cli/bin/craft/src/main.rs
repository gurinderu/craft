//! `craft`: the command line over craft's review.

mod review;

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
    /// Review the changes between a base and HEAD.
    Review(ReviewArgs),
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
        Command::Review(args) => review::run(args).await,
    };
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
