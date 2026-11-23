//! The diff signals that admit the low-yield lenses (realm @nick/craft, node #625): a lens whose
//! profile entry names a `signal` runs only when its profile's part of the change shows it. Read
//! from the lines the change added, in the working tree, of the part's source files — a data file
//! ([`crate::coverage::is_data`]) shows none:
//! - `unsafe`: unsafe code, FFI, `extern`, raw pointers, `transmute`;
//! - `money`: an identifier naming money (amount, price, balance, currency, decimal, cents…);
//! - `concurrency`: threads, async spawns, locks, atomics, channels;
//! - `loop-io`: an allocation or an I/O call in the first lines of a loop the change added — a hot
//!   loop is not visible in a diff, what a loop pays per turn is;
//! - `new-or-large-file`: a source file the change adds, or one it adds [`LARGE`] lines or more to.
//!
//! A change that cannot be read leaves every signal unknown, and an unknown signal admits its
//! lens: a failed read costs tokens, never a lens.

use std::path::Path;

use crate::gate::lines::Lines;
use crate::git::Diff;
use crate::paths::is_test_path;
use crate::state::Track;

mod words;

/// The signals a lens may name.
pub(crate) const SIGNALS: [&str; 5] = [
    "unsafe",
    "money",
    "concurrency",
    "loop-io",
    "new-or-large-file",
];

/// Added lines in one file from which on the change is large for `new-or-large-file`.
pub(crate) const LARGE: usize = 150;

/// The signals one source file's change shows: `added`, its added lines with their numbers;
/// `new`, whether the change adds the file.
pub(crate) fn of_file(added: &[(u32, String)], new: bool) -> Vec<&'static str> {
    let any = |f: fn(&str) -> bool| added.iter().any(|(_, l)| f(l));
    let mut out = Vec::new();
    for (on, s) in [
        (any(words::is_unsafe), "unsafe"),
        (any(words::is_money), "money"),
        (any(words::is_concurrency), "concurrency"),
        (loop_io(added), "loop-io"),
        (new || added.len() >= LARGE, "new-or-large-file"),
    ] {
        if on {
            out.push(s);
        }
    }
    out
}

/// Whether an added line opening a loop has an allocation or an I/O call on itself or an added
/// line at most [`words::LOOP_BODY`] lines below it.
fn loop_io(added: &[(u32, String)]) -> bool {
    added
        .iter()
        .filter(|(_, l)| words::opens_loop(l))
        .any(|(at, _)| {
            added
                .iter()
                .any(|(n, l)| (*at..=at + words::LOOP_BODY).contains(n) && words::is_loop_cost(l))
        })
}

/// The signals `files` show: each source file's ([`of_file`]) — no test file counts for
/// `new-or-large-file`, which judges what will be maintained, not its tests — in [`SIGNALS`]'
/// order, each once.
pub(crate) fn of_part(
    files: &[String],
    added: &dyn Fn(&str) -> Vec<(u32, String)>,
    new: &dyn Fn(&str) -> bool,
) -> Vec<String> {
    let mut seen: Vec<&str> = Vec::new();
    for f in files.iter().filter(|f| !crate::coverage::is_data(f)) {
        let test = is_test_path(f);
        for s in of_file(&added(f), new(f) && !test) {
            if !(test && s == "new-or-large-file") {
                seen.push(s);
            }
        }
    }
    SIGNALS
        .iter()
        .filter(|s| seen.contains(s))
        .map(|s| (*s).to_owned())
        .collect()
}

/// Marks each of `tracks` with the signals its part shows, the change read from the zero-context
/// diff of the checkout `cwd` is in. A change that cannot be read marks every track's signals
/// unknown, and the note it returns says so for the report.
pub(crate) fn mark(cwd: &Path, diff: &Diff, tracks: &mut [Track]) -> Option<String> {
    let read = crate::git::toplevel(cwd).and_then(|top| {
        crate::git::zero_context_diff(cwd, &diff.merge_base).map(|text| (top, text))
    });
    let (top, text) = match read {
        Ok(got) => got,
        Err(e) => {
            for t in tracks.iter_mut() {
                t.signals = None;
            }
            return Some(format!(
                "the lens signals could not be read ({e}): every signal-gated lens was admitted"
            ));
        }
    };
    let (lines, added) = (Lines::parse(&text), crate::design::added_files(&text));
    for t in tracks.iter_mut() {
        let signals = of_part(&t.files, &|f| lines.added_text(&top, f), &|f| {
            added.iter().any(|a| a == f)
        });
        t.signals = Some(signals);
    }
    None
}

#[cfg(test)]
mod tests;
