//! `craft review comment`: a finished run's findings published on its branch's pull request after
//! the fact (realm @nick/craft, node #270) — sorted and posted as a run started with `--comment`
//! is when it finishes, its record told what came of it — printed as the run's finished step.

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

use anyhow::{Context, Result};
use craft_review::filing;
use craft_review::publish::{self, PostSetup};

use crate::steps::{filing_root, print, stamped};

#[derive(Debug, clap::Args)]
pub struct CommentArgs {
    /// The directory of the finished run `start` printed.
    #[arg(long)]
    pub run: PathBuf,
    /// The plugin root the run's telemetry is filed through, for a run whose telemetry knows none
    /// that holds the record writer, as `submit --record-root`.
    #[arg(long)]
    pub record_root: Option<PathBuf>,
}

pub fn comment(args: &CommentArgs) -> Result<ExitCode> {
    let began = Instant::now();
    let run = std::path::absolute(&args.run)
        .with_context(|| format!("resolving {}", args.run.display()))?;
    filing::adopt(&run, filing_root(args.record_root.as_deref()).as_deref());
    let step = stamped(publish::comment(&run, &PostSetup::default())?, began);
    match filing::republished(&run, &step, &filing::NodeWriter) {
        Some(filed) => print(&filing::with_filing(step, filed)),
        None => print(&step),
    }
}
