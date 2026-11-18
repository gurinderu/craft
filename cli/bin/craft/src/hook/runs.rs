//! Whether the run store holds a finished, full craft review of a pull request's head — a
//! craft:review or a craft:rust-audit run ([`counts`]; realm @nick/craft, node #541). The store is
//! the one the record writer files into, `lib/craft-log-run.mjs`: its `index.jsonl`, one JSON line
//! per run, read line by line with a malformed line counted and passed over; a run's detail file is
//! read only for the runs on the head and the branch's newest, since the index carries no scope.

use std::fs::File;
use std::io::{BufRead, BufReader, ErrorKind};
use std::path::Path;

use super::counts::{Counts, counts};
use super::here::{Git, Here};
use super::record::{Line, detail};

/// What a review covered, as the warning names the branch's last one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Full,
    Delta,
    /// The detail file is missing or unreadable.
    Unknown,
}

/// A review run the store holds for the branch.
#[derive(Debug)]
pub struct LastRun {
    pub ts: String,
    pub head: String,
    pub verdict: String,
    pub scope: Scope,
}

#[derive(Debug)]
pub enum Found {
    /// A finished full review of the PR's whole change on its head is filed.
    Reviewed,
    /// None is: the branch's newest review run, if any; whether a finished rust-audit of the head
    /// left files of the change outside its crates; how many index lines did not parse.
    Missing {
        last: Option<LastRun>,
        crates_only: bool,
        malformed: usize,
    },
    /// The store could not be read, and why.
    NoStore(String),
}

/// Looks for a finished full review of `here`'s head in the store at `store`; an index not yet
/// written is a store with no review in it.
pub fn look(store: &Path, here: &Here, git: &dyn Git) -> Found {
    let index = store.join("index.jsonl");
    let file = match File::open(&index) {
        Ok(f) => f,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return Found::Missing {
                last: None,
                crates_only: false,
                malformed: 0,
            };
        }
        Err(e) => return Found::NoStore(format!("{}: {e}", index.display())),
    };
    let mut reader = BufReader::new(file);
    let (mut last, mut malformed, mut crates_only, mut buf) = (None::<Line>, 0, false, Vec::new());
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) => return Found::NoStore(format!("{}: {e}", index.display())),
        }
        if buf.trim_ascii().is_empty() {
            continue;
        }
        let Ok(line) = serde_json::from_slice::<Line>(&buf) else {
            malformed += 1;
            continue;
        };
        if !is_review(&line, here) {
            continue;
        }
        if line.head.as_deref() == Some(&here.head) {
            match counts(&line, detail(store, &line).as_ref(), here, git) {
                Counts::Full => return Found::Reviewed,
                Counts::CratesOnly => crates_only = true,
                Counts::No => {}
            }
        }
        if on_branch(&line, here) && newer(&line, last.as_ref()) {
            last = Some(line);
        }
    }
    // Its detail file is read once, at the end: a branch's every run is newer than the one before.
    let last = last.map(|l| LastRun {
        scope: scope_of(store, &l),
        ts: l.ts.unwrap_or_default(),
        head: l.head.unwrap_or_default(),
        verdict: l.verdict.unwrap_or_default(),
    });
    Found::Missing {
        last,
        crates_only,
        malformed,
    }
}

/// A top-level review run of this repository: the review's name either driver files (`review`,
/// or the CLI's interim `cli-review`, as `isReviewRun`), or `rust-audit`, which craft:develop sends
/// a Rust diff's full review to. A nested run is a rust-audit crate slice and never counts alone.
fn is_review(line: &Line, here: &Here) -> bool {
    matches!(
        line.name.as_deref(),
        Some("review" | "cli-review" | "rust-audit")
    ) && line.project.as_deref() == Some(&here.project)
        && line.nested != Some(true)
}

fn on_branch(line: &Line, here: &Here) -> bool {
    here.branch.is_some() && line.branch == here.branch
}

/// Index timestamps are UTC `YYYY-MM-DDTHH-MM-SSZ`, so text order is time order.
fn newer(line: &Line, than: Option<&Line>) -> bool {
    than.is_none_or(|t| line.ts >= t.ts)
}

fn scope_of(store: &Path, line: &Line) -> Scope {
    match detail(store, line) {
        None => Scope::Unknown,
        Some(d) if d.lens_scope.as_deref() == Some("delta") => Scope::Delta,
        Some(_) => Scope::Full,
    }
}

#[cfg(test)]
#[path = "runs_tests.rs"]
mod tests;
