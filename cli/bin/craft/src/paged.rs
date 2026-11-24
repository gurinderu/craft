//! A step printed in pages (realm @nick/craft, node #625): the Claude Code driver's sandbox reads
//! no file, so a service agent copies what a step command prints, and a large step — a round of
//! many tasks, a finished run's findings — came back cut. With `--paged` the step goes whole to
//! [`FILE`] in its run directory and only its first page is printed; `craft review page` prints
//! the next. The step is the one JSON line `printed` would print, cut by characters: a page is a
//! `craft-out <run> <total> <from> <count>` line naming the run directory, the page's `count` characters of the step from
//! offset `from` on one line, and a `craft-page <end>` line — offsets and counts in UTF-16 code
//! units, as the driver's strings count them, never splitting a character, and not next to
//! whitespace or U+FEFF where the page has another place to end ([`cut::page`]). The driver joins
//! the pages with no separator and checks every count, so a page cut in a copy is seen and asked
//! again, and the command is never run twice.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result};
use serde_json::Value;

mod cut;
mod open;

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
    /// The run directory a paged step's `craft-out` line named: its `host-step.out` is read.
    #[arg(long)]
    pub run: PathBuf,
    /// Where the page starts in the step, in UTF-16 code units from 0.
    #[arg(long)]
    pub from: usize,
}

/// `value` as a step command prints it: whole on one line, or paged when asked and the step names
/// its run directory. A step whose file cannot be written is printed whole: the step has been
/// taken, so it is never lost for want of its file.
pub(crate) fn print(value: &Value, paging: &Paging) -> Result<ExitCode> {
    step_to(
        &mut std::io::stdout().lock(),
        &mut std::io::stderr().lock(),
        value,
        paging,
    )?;
    Ok(ExitCode::SUCCESS)
}

/// [`print()`] to `out`, the note of a step file that could not be written to `err`.
fn step_to(
    out: &mut impl Write,
    err: &mut impl Write,
    value: &Value,
    paging: &Paging,
) -> Result<()> {
    let run = value.get("run").and_then(Value::as_str);
    let (true, Some(run)) = (paging.paged, run) else {
        return crate::printed::write_line(out, value);
    };
    let text = serde_json::to_string(&crate::printed::for_host(value.clone()))?;
    let file = Path::new(run).join(FILE);
    if let Err(e) = write(&file, &text) {
        // The note is best effort: failing to say it must not lose the step.
        drop(writeln!(
            err,
            "craft: {} could not be written ({e}): the step is printed whole",
            file.display()
        ));
        return crate::printed::write_line(out, value);
    }
    page(out, Path::new(run), &text, 0)
}

/// Writes `text` to `file` whole or not at all: through a file beside it, renamed over it, the
/// file beside it removed when that fails.
fn write(file: &Path, text: &str) -> std::io::Result<()> {
    let tmp = file.with_extension("out.tmp");
    let written = std::fs::write(&tmp, text).and_then(|()| std::fs::rename(&tmp, file));
    if written.is_err() {
        // Best effort: a temp file that was never made is no error.
        drop(std::fs::remove_file(&tmp));
    }
    written
}

/// `craft review page`: the page of the step the run in `--run` wrote, from offset `from`.
pub fn page_of(args: &PageArgs) -> Result<ExitCode> {
    let text = open::read_step(&args.run)?;
    page(&mut std::io::stdout().lock(), &args.run, &text, args.from)?;
    Ok(ExitCode::SUCCESS)
}

/// The page of `text` from offset `from`, framed, written to `out`: cut as [`cut::page`] cuts,
/// on a character boundary and not next to whitespace or U+FEFF unless it has no other place.
fn page(out: &mut impl Write, run: &Path, text: &str, from: usize) -> Result<()> {
    let total = cut::units(text);
    let start = cut::byte_at(text, from)
        .with_context(|| format!("offset {from} is no character boundary of the {total}"))?;
    let body = cut::page(text.get(start..).unwrap_or_default());
    let count = cut::units(body);
    writeln!(out, "craft-out {} {total} {from} {count}", run.display())?;
    writeln!(out, "{body}")?;
    writeln!(out, "craft-page {}", from + count)?;
    Ok(())
}

#[cfg(test)]
mod tests;
