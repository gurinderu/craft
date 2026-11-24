//! The diff signals that admit the low-yield lenses (realm @nick/craft, node #625): a lens whose
//! profile entry names a `signal` runs only when its profile's part of the change shows it. Read
//! from the function-context diff of the part's source files — the lines the change added, those
//! it removed and the function around them ([`hunks`]), so an edit inside an existing money path,
//! or a deleted guard, shows it; a data file ([`crate::coverage::is_data`]) shows none:
//! - `money`: an identifier naming money (amount, price, balance, ledger, charge, total, cents,
//!   checkout, cart, purchase, orders, subscription, donation…);
//! - `loop-io`: an allocation or an I/O call in the body of a loop or an iterator chain — a hot
//!   loop is not visible in a diff, what a loop pays per turn is;
//! - `new-or-large-file`: a source file the change adds, one it adds [`LARGE`] lines or more to, or
//!   one it adds [`BRANCH_MIN`] or more branch-introducing lines to.
//!
//! Not gated: Rust's safety lens, whose subject (reachable panics, build-profile arithmetic, a
//! load-bearing `debug_assert!`) has no word to see; the concurrency lenses, whose subject takes
//! more forms across languages than a word list holds — async and channels in every language,
//! `Send`/`Sync`, `static mut`, scoped spawns — and whose misses cost the most; and Nix's
//! maintainability lens, whose yield was not measured.
//!
//! Unknown is not none: a change that cannot be read, or a changed source file it shows no text of
//! (a binary file), leaves its part's signals unknown, and an unknown signal admits its lens — a
//! failed read costs tokens, never a lens.

use std::path::Path;

use crate::git::Diff;
use crate::paths::is_test_path;
use crate::state::Track;

pub(crate) mod hunks;
mod words;

use hunks::FileChange;

/// The signals a lens may name.
pub(crate) const SIGNALS: [&str; 3] = ["money", "loop-io", "new-or-large-file"];

/// Added lines in one file from which on the change is large for `new-or-large-file`.
pub(crate) const LARGE: usize = 150;

/// How many added lines that introduce a branch make a small change count for `new-or-large-file`
/// even when it is not new and not large: a change that grows control flow is what to maintain.
pub(crate) const BRANCH_MIN: usize = 4;

/// Past this many bytes of diff text the signals are not read, and so unknown.
const DIFF_MAX: usize = 64 << 20;

/// The signals one source file's change shows: its hunks' `lines` with their positions, how many
/// lines it `added`, how many of those `branches` introduce control flow, and whether it is `new`.
pub(crate) fn of_file(
    lines: &[(u32, String)],
    added: usize,
    new: bool,
    branches: usize,
) -> Vec<&'static str> {
    let any = |f: fn(&str) -> bool| lines.iter().any(|(_, l)| f(l));
    let mut out = Vec::new();
    for (on, s) in [
        (any(words::is_money), "money"),
        (loop_io(lines), "loop-io"),
        (
            new || added >= LARGE || branches >= BRANCH_MIN,
            "new-or-large-file",
        ),
    ] {
        if on {
            out.push(s);
        }
    }
    out
}

/// Whether a line opening a loop has an allocation or an I/O call on itself or a line at most
/// [`words::LOOP_BODY`] positions below it.
fn loop_io(lines: &[(u32, String)]) -> bool {
    lines
        .iter()
        .filter(|(_, l)| words::opens_loop(l))
        .any(|(at, _)| {
            lines
                .iter()
                .any(|(n, l)| (*at..=at + words::LOOP_BODY).contains(n) && words::is_loop_cost(l))
        })
}

/// The signals `files` show, in [`SIGNALS`]' order, each once — no test file counts for
/// `new-or-large-file`, which judges what will be maintained, not its tests; `None`, unknown,
/// when a source file among them is not in `changes` or shows no text.
pub(crate) fn of_part(
    files: &[String],
    changes: &dyn Fn(&str) -> Option<FileChange>,
) -> Option<Vec<String>> {
    let mut seen: Vec<&str> = Vec::new();
    for f in files.iter().filter(|f| !crate::coverage::is_data(f)) {
        let change = changes(f)?;
        let lines = change.lines?;
        let test = is_test_path(f);
        for s in of_file(&lines, change.added, change.new, change.branches) {
            if !(test && s == "new-or-large-file") {
                seen.push(s);
            }
        }
    }
    Some(
        SIGNALS
            .iter()
            .filter(|s| seen.contains(s))
            .map(|s| (*s).to_owned())
            .collect(),
    )
}

/// `text`, when it is at most `max` bytes.
fn bounded(text: String, max: usize) -> Result<String, String> {
    if text.len() > max {
        Err(format!("its diff is over {max} bytes"))
    } else {
        Ok(text)
    }
}

/// Marks each of `tracks` with the signals its part shows, the change read from the
/// function-context diff of the checkout `cwd` is in. A change that cannot be read leaves every
/// track's signals unknown, and the note it returns says so for the report.
pub(crate) fn mark(cwd: &Path, diff: &Diff, tracks: &mut [Track]) -> Option<String> {
    let text = crate::git::function_context_diff(cwd, &diff.merge_base)
        .map_err(|e| e.to_string())
        .and_then(|t| bounded(t, DIFF_MAX));
    let text = match text {
        Ok(t) => t,
        Err(e) => {
            for t in tracks.iter_mut() {
                t.signals = None;
            }
            return Some(format!(
                "the lens signals could not be read ({e}): every signal-gated lens was admitted"
            ));
        }
    };
    let changes = hunks::parse(&text);
    for t in tracks.iter_mut() {
        t.signals = of_part(&t.files, &|f| changes.get(f).cloned());
    }
    None
}

#[cfg(test)]
mod hunks_tests;
#[cfg(test)]
mod tests;
