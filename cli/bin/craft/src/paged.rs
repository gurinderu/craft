//! A step printed in pages (realm @nick/craft, node #625): the Claude Code driver's sandbox reads
//! no file, so a service agent copies what a step command prints, and a large step — a round of
//! many tasks, a finished run's findings — came back cut. With `--paged` the step goes whole to
//! [`FILE`] in its run directory and only its first page is printed; `craft review page` prints
//! the next. The step is the one JSON line `printed` would print, cut by characters: a page is a
//! `craft-out <file> <total> <from> <count>` line, the page's `count` characters of the step from
//! offset `from` on one line, and a `craft-page <end>` line — offsets and counts in UTF-16 code
//! units, as the driver's strings count them, and never splitting a character. The driver joins
//! the pages with no separator and checks every count, so a page cut in a copy is seen and asked
//! again, and the command is never run twice.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result};
use serde_json::Value;

mod cut;

/// The run directory's file a paged step is written to.
pub const FILE: &str = "host-step.out";

#[derive(Debug, Default, clap::Args)]
pub struct Paging {
    /// Write the step to `host-step.out` in its run directory and print only its first page,
    /// framed; `craft review page` prints the rest.
    #[arg(long)]
    pub paged: bool,
}

#[derive(Debug, clap::Args)]
pub struct PageArgs {
    /// The `host-step.out` of a run directory, as a paged step's `craft-out` line named it.
    #[arg(long)]
    pub file: PathBuf,
    /// Where the page starts in the step, in UTF-16 code units from 0.
    #[arg(long)]
    pub from: usize,
}

/// `value` as a step command prints it: whole on one line, or paged when asked and the step names
/// its run directory. A step whose file cannot be written is printed whole: the step has been
/// taken, so it is never lost for want of its file.
pub(crate) fn print(value: &Value, paging: &Paging) -> Result<ExitCode> {
    step_to(&mut std::io::stdout().lock(), value, paging)?;
    Ok(ExitCode::SUCCESS)
}

/// [`print`] to `out`.
fn step_to(out: &mut impl Write, value: &Value, paging: &Paging) -> Result<()> {
    let run = value.get("run").and_then(Value::as_str);
    let (true, Some(run)) = (paging.paged, run) else {
        return crate::printed::write_line(out, value);
    };
    let text = serde_json::to_string(&crate::printed::for_host(value.clone()))?;
    let file = Path::new(run).join(FILE);
    if write(&file, &text).is_err() {
        return crate::printed::write_line(out, value);
    }
    page(out, &file, &text, 0)
}

/// Writes `text` to `file` whole or not at all: through a file beside it, renamed over it.
fn write(file: &Path, text: &str) -> std::io::Result<()> {
    let tmp = file.with_extension("out.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, file)
}

/// `craft review page`: the page of a paged step's file from offset `from`. Only a run
/// directory's [`FILE`] is read.
pub fn page_of(args: &PageArgs) -> Result<ExitCode> {
    let file = &args.file;
    let in_run = file.file_name().is_some_and(|n| n == FILE)
        && file
            .parent()
            .is_some_and(|d| d.join("state.json").is_file());
    anyhow::ensure!(
        in_run,
        "{} is not the {FILE} of a run directory",
        file.display()
    );
    let text =
        std::fs::read_to_string(file).with_context(|| format!("reading {}", file.display()))?;
    page(&mut std::io::stdout().lock(), file, &text, args.from)?;
    Ok(ExitCode::SUCCESS)
}

/// The page of `text` from offset `from`, framed, written to `out`.
fn page(out: &mut impl Write, file: &Path, text: &str, from: usize) -> Result<()> {
    let total = cut::units(text);
    let start = cut::byte_at(text, from)
        .with_context(|| format!("offset {from} is no character boundary of the {total}"))?;
    let body = cut::page(text.get(start..).unwrap_or_default());
    let count = cut::units(body);
    writeln!(out, "craft-out {} {total} {from} {count}", file.display())?;
    writeln!(out, "{body}")?;
    writeln!(out, "craft-page {}", from + count)?;
    Ok(())
}

#[cfg(test)]
mod tests;
