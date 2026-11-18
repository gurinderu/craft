//! The name search: the lines of the working tree that name a symbol as a whole word, from
//! `git grep -n -w -I -F -z` over the tracked files, build output, lockfiles and vendored trees
//! left out — always run, because a code graph loses edges (a function passed as a value).

use std::path::Path;
use std::process::Command;

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

/// The lines of the working tree at `top` that name `name` as a whole word; `Err` with the count
/// when more than [`HITS_MAX`] do, or with git's reason.
pub(super) fn search(top: &Path, name: &str) -> Result<Vec<Hit>, String> {
    let out = Command::new("git")
        .arg("-C")
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
            ".",
        ])
        .args(EXCLUDE)
        .output()
        .map_err(|e| format!("git grep could not run: {e}"))?;
    match out.status.code() {
        Some(0) => {}
        Some(1) => return Ok(Vec::new()),
        _ => {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(format!("git grep failed: {}", err.trim()));
        }
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let hits: Vec<Hit> = text.lines().filter_map(hit).collect();
    if hits.len() > HITS_MAX {
        return Err(format!("{} lines", hits.len()));
    }
    Ok(hits)
}

/// One `path\0line\0text` line of `git grep -z -n`.
fn hit(l: &str) -> Option<Hit> {
    let mut parts = l.splitn(3, '\0');
    let file = parts.next()?.to_owned();
    let line = parts.next()?.parse().ok()?;
    let text = parts.next()?.to_owned();
    Some(Hit { file, line, text })
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
