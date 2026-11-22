//! `craft memory reindex`: craft's own index of its records in the harness's project memory
//! directory rebuilt from the record files, and the per-record lines earlier releases left in the
//! harness's `MEMORY.md` moved out of it ([`index`]). Idempotent: a second run writes nothing.

mod index;
#[cfg(test)]
mod tests;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result, bail};
use serde_json::json;

use index::{Entry, HARNESS_FILE, INDEX_FILE};

#[derive(Debug, clap::Subcommand)]
pub enum MemoryCommand {
    /// Rebuild `craft-memory.md` from the record files of a harness memory directory and move
    /// craft's per-record lines out of its `MEMORY.md`, leaving one pointer line and every other
    /// line as it was. Prints what it did as JSON.
    Reindex(ReindexArgs),
}

#[derive(Debug, clap::Args)]
pub struct ReindexArgs {
    /// The harness's project memory directory (`~/.claude/projects/<slug>/memory`).
    #[arg(long)]
    pub dir: PathBuf,
}

/// What one reindex did; `skipped` the record files it could not read as text, each named.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Outcome {
    pub indexed: usize,
    pub moved: usize,
    pub index_written: bool,
    pub harness_written: bool,
    pub skipped: Vec<String>,
}

pub fn memory(cmd: &MemoryCommand) -> Result<ExitCode> {
    let MemoryCommand::Reindex(args) = cmd;
    let o = reindex(&args.dir)?;
    #[expect(clippy::print_stdout, reason = "the command's one JSON result")]
    {
        println!(
            "{}",
            json!({"indexed": o.indexed, "moved": o.moved, "indexWritten": o.index_written, "harnessWritten": o.harness_written, "skipped": o.skipped})
        );
    }
    Ok(ExitCode::SUCCESS)
}

/// craft's records among the directory's files, and the names of record files that are not
/// UTF-8 text (skipped, never a failure of the whole run).
fn entries(dir: &Path) -> Result<(Vec<Entry>, Vec<String>)> {
    let (mut out, mut skipped) = (Vec::new(), Vec::new());
    for item in fs::read_dir(dir).with_context(|| format!("reading {}", dir.display()))? {
        let item = item?;
        let name = item.file_name().to_string_lossy().into_owned();
        if !index::is_record_name(&name) || !item.file_type()?.is_file() {
            continue;
        }
        let bytes =
            fs::read(item.path()).with_context(|| format!("reading {}", item.path().display()))?;
        match String::from_utf8(bytes) {
            Ok(text) => out.extend(index::entry(&name, &text)),
            Err(_) => skipped.push(format!("{name}: not UTF-8 text")),
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    skipped.sort();
    Ok((out, skipped))
}

/// Writes `text` to `path` through a sibling temporary file, unless it already holds it. A
/// symbolic link is followed and its target written, so the rename never replaces the link with
/// a plain file; a link whose target is missing is refused.
fn write_if_changed(path: &Path, text: &str) -> Result<bool> {
    if fs::read_to_string(path).ok().as_deref() == Some(text) {
        return Ok(false);
    }
    let resolved;
    let path = if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        resolved = fs::canonicalize(path).with_context(|| {
            format!(
                "{} is a symbolic link whose target cannot be resolved — refused, so the link is not replaced; nothing written to it",
                path.display()
            )
        })?;
        resolved.as_path()
    } else {
        path
    };
    let tmp = path.with_extension("md.craft-tmp");
    fs::write(&tmp, text).with_context(|| format!("writing {}", tmp.display()))?;
    fs::rename(&tmp, path).with_context(|| format!("replacing {}", path.display()))?;
    Ok(true)
}

/// Rebuilds the index of `dir`, then moves craft's lines out of its `MEMORY.md` — the index
/// first, so an interrupted run loses no line. A directory with no craft record is left as it is.
///
/// # Errors
/// When `dir` is not a directory, its `MEMORY.md` says not to write there, or a file cannot be
/// read or written.
pub(crate) fn reindex(dir: &Path) -> Result<Outcome> {
    if !dir.is_dir() {
        bail!("harness memory directory {} not found", dir.display());
    }
    let harness_path = dir.join(HARNESS_FILE);
    let harness = match fs::read_to_string(&harness_path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) if e.kind() == std::io::ErrorKind::InvalidData => bail!(
            "{} is not UTF-8 text — refused, so none of its lines is rewritten; nothing written",
            harness_path.display()
        ),
        Err(e) => return Err(e).with_context(|| format!("reading {}", harness_path.display())),
    };
    if index::forbids_writes(&harness) {
        bail!(
            "{} says not to write here — the harness memory backend is unavailable; nothing written",
            harness_path.display()
        );
    }
    let (all, skipped) = entries(dir)?;
    if all.is_empty() {
        return Ok(Outcome {
            indexed: 0,
            moved: 0,
            index_written: false,
            harness_written: false,
            skipped,
        });
    }
    let index_written = write_if_changed(&dir.join(INDEX_FILE), &index::render(&all))?;
    let is_craft = |name: &str| all.iter().any(|e| format!("{}.md", e.id) == name);
    let (text, moved) = index::migrate(&harness, &is_craft);
    let harness_written = write_if_changed(&harness_path, &text)?;
    Ok(Outcome {
        indexed: all.iter().filter(|e| e.active).count(),
        moved,
        index_written,
        harness_written,
        skipped,
    })
}
