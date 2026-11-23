//! A step printed in pages (realm @nick/craft, node #625): the Claude Code driver's sandbox reads
//! no file, so a service agent copies what a step command prints, and a large step — a round of
//! many tasks, a finished run's findings — came back cut. With `--paged` the step goes whole to
//! [`FILE`] in its run directory and only its first page is printed; `craft review page` prints
//! the next. A page is framed — a `craft-out <file> <lines>` line first, a `craft-page <last>`
//! line after it — so a page that comes back cut is seen and asked again, and the command is never
//! run twice. The step is cut into lines at each `,"`: in JSON that pair stands only between
//! tokens (a quote inside a string is escaped), so the lines joined with newlines are the same
//! value, and a page never splits a character.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result};
use serde_json::Value;

/// The run directory's file a paged step is written to.
pub const FILE: &str = "host-step.out";
/// How many characters a page holds, its first line aside: a longer line is a page of its own.
const PAGE_CHARS: usize = 8000;

#[derive(Debug, Default, clap::Args)]
pub struct Paging {
    /// Write the step to `host-step.out` in its run directory and print only its first page,
    /// framed; `craft review page` prints the rest.
    #[arg(long)]
    pub paged: bool,
}

#[derive(Debug, clap::Args)]
pub struct PageArgs {
    /// The file a paged step named on its `craft-out` line.
    #[arg(long)]
    pub file: PathBuf,
    /// The first line of the page, counted from 1.
    #[arg(long)]
    pub from: usize,
}

/// `value` as a step command prints it: whole on one line, or paged when asked and the step names
/// its run directory.
pub(crate) fn print(value: &Value, paging: &Paging) -> Result<ExitCode> {
    let run = value.get("run").and_then(Value::as_str);
    let (true, Some(run)) = (paging.paged, run) else {
        return crate::steps::print(value);
    };
    let text = serde_json::to_string(&crate::printed::for_host(value.clone()))?;
    let file = Path::new(run).join(FILE);
    let lines = text.replace(",\"", ",\n\"");
    std::fs::write(&file, format!("{lines}\n"))
        .with_context(|| format!("writing {}", file.display()))?;
    page(&mut std::io::stdout().lock(), &file, &lines, 1)?;
    Ok(ExitCode::SUCCESS)
}

/// `craft review page`: the page of a paged step's file from line `from`.
pub fn page_of(args: &PageArgs) -> Result<ExitCode> {
    let text = std::fs::read_to_string(&args.file)
        .with_context(|| format!("reading {}", args.file.display()))?;
    page(&mut std::io::stdout().lock(), &args.file, &text, args.from)?;
    Ok(ExitCode::SUCCESS)
}

/// The page of `text`'s lines from line `from` (1-based), framed, written to `out`.
fn page(out: &mut impl Write, file: &Path, text: &str, from: usize) -> Result<()> {
    let lines: Vec<&str> = text.lines().collect();
    writeln!(out, "craft-out {} {}", file.display(), lines.len())?;
    let mut used = 0;
    let mut last = from.saturating_sub(1);
    for (n, line) in lines.iter().enumerate().skip(last) {
        let len = line.chars().count() + 1;
        if n + 1 > from && used + len > PAGE_CHARS {
            break;
        }
        writeln!(out, "{line}")?;
        used += len;
        last = n + 1;
    }
    writeln!(out, "craft-page {last}")?;
    Ok(())
}

#[cfg(test)]
mod tests;
