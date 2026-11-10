//! The CI map's candidates in a repository's workflows (realm @nick/craft, node #483): a job
//! whose `run:` names a cargo command itself is resolved — its check, the signal and the command
//! line; one that calls a recipe (`just`, `make`, `cargo xtask`, a script) is unresolved, its run
//! lines and workflow named, for the session to read the recipe and quote what it runs. Each names
//! the local actions its job runs (`uses: ./…`), which an entry must list among its sources; a
//! clippy command that does not deny warnings carries a note for the reviewer.

use std::path::Path;

use serde::Serialize;

use super::check_claim_propose::unclaimed;
use super::check_name::{check_of, expanded};
use super::shell::{cargo_sub, commands, hints, recipe};
use super::signal::Signal;
use super::workflow::{Job, jobs, workflow_files};

/// A resolved candidate: the job's check, the signal, and the command line that gives it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Resolved {
    pub check: String,
    /// A matrix job, which GitHub reports as `<check> (…)` per combination.
    pub matrix: bool,
    pub signal: Signal,
    pub command: String,
    pub workflow: String,
    /// The local paths the job's `uses: ./…` names, without `./`.
    pub uses: Vec<String>,
    /// What the reviewer should know before confirming it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// An unresolved candidate: a job calling a recipe, with the signals its words hint at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Unresolved {
    pub check: String,
    pub matrix: bool,
    pub runs: Vec<String>,
    pub hints: Vec<Signal>,
    pub workflow: String,
    pub uses: Vec<String>,
    /// What the reviewer should know before resolving it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Candidate {
    Resolved(Resolved),
    Unresolved(Unresolved),
}

const NO_DENY: &str = "the command does not pass `-D warnings`: unless the job denies warnings another way (RUSTFLAGS, say), a clippy warning does not fail this check";

/// The note a resolved candidate carries: a clippy command that does not deny warnings.
fn note(signal: Signal, command: &str) -> Option<String> {
    let denies = [
        "-D warnings",
        "-Dwarnings",
        "--deny warnings",
        "--deny=warnings",
    ]
    .iter()
    .any(|d| command.contains(d));
    (signal == Signal::Clippy && !denies).then(|| NO_DENY.to_owned())
}

/// The candidates of one job of `workflow`: under the check its name reports as, or one
/// unresolved with a note when GitHub expands its name past any check.
fn of_job(workflow: &str, j: &Job) -> Vec<Candidate> {
    let name = j.name.as_deref().unwrap_or(&j.id);
    match check_of(name) {
        Ok(check) => checked(workflow, j, check),
        Err(note) => expanded(workflow, j, name, note)
            .map(Candidate::Unresolved)
            .into_iter()
            .collect(),
    }
}

/// The candidates of job `j` of `workflow`, whose runs GitHub reports as `check`.
fn checked(workflow: &str, j: &Job, check: &str) -> Vec<Candidate> {
    let check = check.to_owned();
    let mut out = Vec::new();
    let mut open = Vec::new();
    for c in j.runs.iter().flat_map(|l| commands(l)) {
        if let Some(signal) = cargo_sub(c).and_then(Signal::of_cargo) {
            out.push(Candidate::Resolved(Resolved {
                check: check.clone(),
                matrix: j.matrix,
                signal,
                command: c.to_owned(),
                workflow: workflow.to_owned(),
                uses: j.uses.clone(),
                note: note(signal, c),
            }));
        } else if recipe(c) {
            open.push(c.to_owned());
        }
    }
    let hinted = hints(&format!("{check} {}", open.join(" ")));
    if !open.is_empty() && !hinted.is_empty() {
        out.push(Candidate::Unresolved(Unresolved {
            check,
            matrix: j.matrix,
            runs: open,
            hints: hinted,
            workflow: workflow.to_owned(),
            uses: j.uses.clone(),
            note: None,
        }));
    }
    out
}

/// The candidates of the workflow `text` at `workflow`, job by job.
#[must_use]
pub fn candidates_in(workflow: &str, text: &str) -> Vec<Candidate> {
    let all = jobs(text);
    let found = all.iter().flat_map(|j| of_job(workflow, j)).collect();
    unclaimed(workflow, &all, found)
}

/// The candidates of every workflow under `top` ([`workflow_files`]), by file name.
///
/// # Errors
/// When the directory or a workflow cannot be read.
pub fn candidates(top: &Path) -> std::io::Result<Vec<Candidate>> {
    let mut out = Vec::new();
    for f in workflow_files(top)? {
        out.extend(candidates_in(&f, &std::fs::read_to_string(top.join(&f))?));
    }
    Ok(out)
}
