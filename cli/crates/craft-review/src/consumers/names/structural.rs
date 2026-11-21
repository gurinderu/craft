//! The structural search (realm @nick/craft, node #529): a too-common name's lines whose paths
//! reach it through its owner ([`paths`]), over the files `git grep` finds naming both, each read
//! as the list reads a file ([`source::read_within`]) and parsed within the search's deadline.

use std::path::Path;
use std::process::Command;
use std::time::Instant;

use tree_sitter::Tree;

use super::super::source;
use super::crates::externals;
use super::paths;
use super::stream::{Ended, Format, out_of_time, stream_as};
use super::{EXCLUDE, HITS_MAX, Hit, RUST};
use crate::cancel::{Cancel, STOPPED};

/// How many files naming both the owner and the name are read.
const FILES_MAX: usize = 2000;

/// What the structural search found: the lines, and the files it could not read, `file (why)`.
#[derive(Debug, Default)]
pub(in crate::consumers) struct Found {
    pub hits: Vec<Hit>,
    pub unread: Vec<String>,
}

/// The lines of the working tree's Rust sources at `top` whose paths reach `name`, declared at
/// `declared` (`file`, 1-based line); `None` when it is no item of an `impl` or a trait, or its file
/// is absent; `Err` once more than [`HITS_MAX`] lines do, when its own file cannot be read, when
/// `deadline` passes or `cancel` is first, or with git's reason.
pub(in crate::consumers) fn by_path(
    top: &Path,
    (file, line): (&str, u32),
    name: &str,
    deadline: Instant,
    cancel: &Cancel,
) -> Result<Option<Found>, String> {
    let until = (deadline, cancel);
    let Some(text) =
        source::read_within(top, file).map_err(|e| format!("its file not read: {e}"))?
    else {
        return Ok(None);
    };
    let Some(own) = paths::owner(&parse_until(&text, until)?, &text, line, name) else {
        return Ok(None);
    };
    let ext = externals(top, until);
    let mut found = Found::default();
    for f in candidates(top, own.name(), name, until)? {
        let text = match source::read_within(top, &f) {
            Ok(Some(t)) => t,
            Ok(None) => continue,
            Err(e) => {
                found.unread.push(format!("{f} ({e})"));
                continue;
            }
        };
        let tree = parse_until(&text, until)?;
        let lines: Vec<&str> = text.lines().collect();
        found.hits.extend(
            paths::reaching(&tree, &text, (name, &own), &ext)
                .into_iter()
                .map(|n| {
                    let at = usize::try_from(n).ok().and_then(|n| n.checked_sub(1));
                    let text = at.and_then(|i| lines.get(i)).copied().unwrap_or_default();
                    Hit {
                        file: f.clone(),
                        line: n,
                        text: text.to_owned(),
                    }
                }),
        );
        if found.hits.len() > HITS_MAX {
            return Err(super::Unfinished::Capped.to_string());
        }
    }
    Ok(Some(found))
}

/// `Err` once `deadline` has passed or `cancel` is.
fn in_time((deadline, cancel): (Instant, &Cancel)) -> Result<(), String> {
    if cancel.is_cancelled() {
        return Err(STOPPED.into());
    }
    if Instant::now() >= deadline {
        return Err(out_of_time());
    }
    Ok(())
}

/// The syntax tree of `text`, its parse stopped once `deadline` passes or `cancel` is.
fn parse_until(text: &str, until: (Instant, &Cancel)) -> Result<Tree, String> {
    in_time(until)?;
    let tree = paths::parse(text, &mut || in_time(until).is_err());
    in_time(until)?;
    tree.ok_or_else(|| "the Rust grammar could not be loaded".to_owned())
}

/// A path of `git grep -l -z`.
fn path(p: &str) -> Option<Hit> {
    (!p.is_empty()).then(|| Hit {
        file: p.to_owned(),
        line: 0,
        text: String::new(),
    })
}

/// The tracked Rust sources at `top` naming both `owner` and `name` as whole words, as the name
/// search reads them.
fn candidates(
    top: &Path,
    owner: &str,
    name: &str,
    (deadline, cancel): (Instant, &Cancel),
) -> Result<Vec<String>, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(top).args([
        "grep",
        "-l",
        "-z",
        "-w",
        "-I",
        "-F",
        "--full-name",
        "--all-match",
        "-e",
        owner,
        "-e",
        name,
        "--",
        RUST,
    ]);
    cmd.args(EXCLUDE);
    let paths = Format {
        sep: 0,
        parse: path,
        max: FILES_MAX,
    };
    match stream_as(cmd, paths, deadline, cancel)? {
        Ended::Capped => Err(format!("over {FILES_MAX} files name {owner} and {name}")),
        Ended::Exited(Some(0), hits, _) => Ok(hits.into_iter().map(|h| h.file).collect()),
        Ended::Exited(Some(1), ..) => Ok(Vec::new()),
        Ended::Exited(_, _, err) => Err(format!("git grep failed: {}", err.trim())),
    }
}

#[cfg(test)]
#[path = "structural_tests.rs"]
mod tests;
