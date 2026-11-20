//! The name search: the lines of the working tree that name a symbol as a whole word, from
//! `git grep -n -w -I -F -z` over the tracked Rust sources, build output, lockfiles and vendored
//! trees left out; it finds a function passed as a value as well as a call.

use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use crate::cancel::Cancel;

mod stream;

use stream::{Ended, stream};

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
) -> Result<Vec<Hit>, String> {
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
        Ended::Capped => Err(format!("over {HITS_MAX} lines")),
        Ended::Exited(Some(0), hits, _) => Ok(hits),
        Ended::Exited(Some(1), ..) => Ok(Vec::new()),
        Ended::Exited(_, _, err) => Err(format!("git grep failed: {}", err.trim())),
    }
}

#[cfg(test)]
mod tests;
