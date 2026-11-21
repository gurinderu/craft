//! The name search: the lines of the working tree that name a symbol as a whole word, from
//! `git grep -n -w -I -F -z` over the tracked Rust sources, build output, lockfiles and vendored
//! trees left out — always run, because a code graph loses edges (a function passed as a value).

use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use crate::cancel::Cancel;

mod crates;
mod paths;
mod stream;
mod structural;
mod unfinished;

use stream::{Ended, stream};
pub(super) use structural::by_path;
pub(super) use unfinished::Unfinished;

/// Names too common for a whole-word search to tell one symbol's uses from another's.
const COMMON: [&str; 40] = [
    "new",
    "from",
    "default",
    "into",
    "clone",
    "fmt",
    "drop",
    "eq",
    "hash",
    "len",
    "is_empty",
    "get",
    "set",
    "run",
    "build",
    "parse",
    "next",
    "as_ref",
    "deref",
    "try_from",
    "from_str",
    "to_string",
    "main",
    "test",
    "iter",
    "write",
    "read",
    "open",
    "close",
    "check",
    "init",
    "start",
    "update",
    "apply",
    "call",
    "with",
    "map",
    "push",
    "insert",
    "remove",
];
/// A name matching more lines than this is too common to list.
pub(super) const HITS_MAX: usize = 200;
/// How long the name search of all a review's symbols may take, past which the rest are not
/// searched.
pub(super) const BUDGET: Duration = Duration::from_secs(60);
/// What the search reads: Rust sources only, the language whose symbols it searches.
const RUST: &str = ":(glob)**/*.rs";
/// What the search never reads.
const EXCLUDE: [&str; 6] = [
    ":(exclude,glob)**/target/**",
    ":(exclude,glob)**/node_modules/**",
    ":(exclude,glob)**/vendor/**",
    ":(exclude,glob)**/*.lock",
    ":(exclude,glob)**/*.min.js",
    ":(exclude,glob)**/generated/**",
];

/// One line naming a symbol.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Hit {
    pub file: String,
    pub line: u32,
    pub text: String,
}

/// Why a name is not searched: a common one, or too short to tell apart.
pub(super) fn skip(name: &str) -> bool {
    name.len() < 3 || COMMON.contains(&name)
}

/// The lines of the working tree's Rust sources at `top` that name `name` as a whole word; `Err`
/// once more than [`HITS_MAX`] do, when `deadline` passes or `cancel` is first, or with git's
/// reason.
pub(super) fn search(
    top: &Path,
    name: &str,
    deadline: Instant,
    cancel: &Cancel,
) -> Result<Vec<Hit>, Unfinished> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(top)
        .args([
            "grep",
            "-n",
            "-w",
            "-I",
            "-F",
            "-z",
            "--full-name",
            "-e",
            name,
            "--",
            RUST,
        ])
        .args(EXCLUDE);
    match stream(cmd, deadline, cancel)? {
        Ended::Capped => Err(Unfinished::Capped),
        Ended::Exited(Some(0), hits, _) => Ok(hits),
        Ended::Exited(Some(1), ..) => Ok(Vec::new()),
        Ended::Exited(_, _, err) => Err(format!("git grep failed: {}", err.trim()).into()),
    }
}

/// Whether `text` names `name` as a whole word.
pub(super) fn names(text: &str, name: &str) -> bool {
    let ident = |c: char| c.is_ascii_alphanumeric() || c == '_';
    text.match_indices(name).any(|(i, _)| {
        let before = text.get(..i).and_then(|s| s.chars().next_back());
        let after = text.get(i + name.len()..).and_then(|s| s.chars().next());
        !before.is_some_and(ident) && !after.is_some_and(ident)
    })
}

#[cfg(test)]
mod tests;
