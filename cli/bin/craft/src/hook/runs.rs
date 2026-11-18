//! Whether the run store holds a finished, full craft review of a head (realm @nick/craft, node
//! #541). The store is the one the record writer files into, `lib/craft-log-run.mjs`: its
//! `index.jsonl`, one JSON line per run, read line by line with a malformed line counted and passed
//! over; a run's detail file ([`scope_of`]) is read only for the runs on the head or the branch's
//! newest, since the index carries no `lensScope`.

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use super::record::{Line, scope_of};

/// The checkout a pull request is opened from, as the store keys it.
pub struct Here {
    /// The repository as records name it (`repoKey`: the main checkout for a linked worktree).
    pub project: String,
    pub head: String,
    /// `None` on a detached `HEAD`, as records file it.
    pub branch: Option<String>,
}

/// What a review covered: every lens over the branch, or only a fix's delta.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Full,
    Delta,
    /// The detail file could not be read.
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
    /// A finished full review of the head is filed.
    Reviewed,
    /// None is: the branch's newest review run, if any, and how many index lines did not parse.
    Missing {
        last: Option<LastRun>,
        malformed: usize,
    },
    /// The store could not be read, and why.
    NoStore(String),
}

/// Looks for a finished full review of `here`'s head in the store at `store`.
pub fn look(store: &Path, here: &Here) -> Found {
    let index = store.join("index.jsonl");
    let file = match File::open(&index) {
        Ok(f) => f,
        Err(e) => return Found::NoStore(format!("{}: {e}", index.display())),
    };
    let mut reader = BufReader::new(file);
    let (mut last, mut malformed, mut buf) = (None::<Line>, 0, Vec::new());
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
        let scope = (line.head.as_deref() == Some(&here.head)).then(|| scope_of(store, &line));
        if scope.is_some_and(|s| finished_full(&line, s)) {
            return Found::Reviewed;
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
    Found::Missing { last, malformed }
}

/// A top-level review run of this repository: the review's name either driver files (`review`,
/// or the CLI's interim `cli-review`, as `isReviewRun`); a nested one is a rust-audit crate slice.
fn is_review(line: &Line, here: &Here) -> bool {
    matches!(line.name.as_deref(), Some("review" | "cli-review"))
        && line.project.as_deref() == Some(&here.project)
        && line.nested != Some(true)
}

fn on_branch(line: &Line, here: &Here) -> bool {
    here.branch.is_some() && line.branch == here.branch
}

/// Index timestamps are UTC `YYYY-MM-DDTHH-MM-SSZ`, so text order is time order.
fn newer(line: &Line, than: Option<&Line>) -> bool {
    than.is_none_or(|t| line.ts >= t.ts)
}

/// Finished and full: a verdict, not INCOMPLETE, not a partial record recovered from checkpoints,
/// not a delta round. A record filed before `lensScope` existed was a full review.
fn finished_full(line: &Line, scope: Scope) -> bool {
    let verdict = line.verdict.as_deref().unwrap_or_default();
    !verdict.is_empty() && !verdict.contains("INCOMPLETE") && scope == Scope::Full
}

#[cfg(test)]
#[path = "runs_tests.rs"]
mod tests;
