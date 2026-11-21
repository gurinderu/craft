//! The files the structural search reads: the tracked Rust sources naming the name (and, for an
//! owner's item, one of the owner's words), as the name search reads them.

use std::collections::BTreeSet;
use std::path::Path;
use std::process::Command;

use super::super::stream::{Ended, Format, stream_as};
use super::super::{EXCLUDE, Hit, RUST};
use super::Until;

/// How many files are read.
pub(super) const FILES_MAX: usize = 2000;

/// A path of `git grep -l -z`.
fn path(p: &str) -> Option<Hit> {
    (!p.is_empty()).then(|| Hit {
        file: p.to_owned(),
        line: 0,
        text: String::new(),
    })
}

/// The tracked Rust sources at `top` naming every one of `all` as a whole word.
pub(super) fn naming(top: &Path, all: &[&str], until: Until<'_>) -> Result<Vec<String>, String> {
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
    ]);
    for word in all {
        cmd.arg("-e").arg(word);
    }
    cmd.arg("--").arg(RUST).args(EXCLUDE);
    let paths = Format {
        sep: 0,
        parse: path,
        max: FILES_MAX,
    };
    let (deadline, cancel) = until;
    match stream_as(cmd, paths, deadline, cancel)? {
        Ended::Capped => Err(format!("over {FILES_MAX} files name {}", all.join(" and "))),
        Ended::Exited(Some(0), hits, _) => Ok(hits.into_iter().map(|h| h.file).collect()),
        Ended::Exited(Some(1), ..) => Ok(Vec::new()),
        Ended::Exited(_, _, err) => Err(format!("git grep failed: {}", err.trim())),
    }
}

/// The files naming `name` and, when `words` holds any, one of them too; past [`FILES_MAX`] in
/// all, `Err`.
pub(super) fn candidates(
    top: &Path,
    words: &[&str],
    name: &str,
    until: Until<'_>,
) -> Result<Vec<String>, String> {
    if words.is_empty() {
        return naming(top, &[name], until);
    }
    let mut all = BTreeSet::new();
    for w in words.iter().collect::<BTreeSet<_>>() {
        all.extend(naming(top, &[w, name], until)?);
        if all.len() > FILES_MAX {
            return Err(format!("over {FILES_MAX} files name {name} and its owner"));
        }
    }
    Ok(all.into_iter().collect())
}
