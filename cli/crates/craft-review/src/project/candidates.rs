//! The CI map's candidates in a repository's workflows (realm @nick/craft, node #483): a job
//! whose `run:` names a cargo command itself is resolved — its check, the signal and the command
//! line; one that calls a recipe (`just`, `make`, `cargo xtask`, a script) is unresolved, its run
//! lines and workflow named, for the session to read the recipe and quote what it runs.

use std::path::Path;

use serde::Serialize;

use super::shell::{cargo_sub, commands, hints, recipe};
use super::signal::Signal;
use super::workflow::{Job, jobs};

/// A resolved candidate: the job's check, the signal, and the command line that gives it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Resolved {
    pub check: String,
    /// A matrix job, which GitHub reports as `<check> (…)` per combination.
    pub matrix: bool,
    pub signal: Signal,
    pub command: String,
    pub workflow: String,
}

/// An unresolved candidate: a job calling a recipe, with the signals its words hint at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Unresolved {
    pub check: String,
    pub matrix: bool,
    pub runs: Vec<String>,
    pub hints: Vec<Signal>,
    pub workflow: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Candidate {
    Resolved(Resolved),
    Unresolved(Unresolved),
}

/// The candidates of one job of `workflow`.
fn of_job(workflow: &str, j: &Job) -> Vec<Candidate> {
    let check = j.name.clone().unwrap_or_else(|| j.id.clone());
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
        }));
    }
    out
}

/// The candidates of the workflow `text` at `workflow`, job by job.
#[must_use]
pub fn candidates_in(workflow: &str, text: &str) -> Vec<Candidate> {
    jobs(text)
        .iter()
        .flat_map(|j| of_job(workflow, j))
        .collect()
}

/// The candidates of every `.github/workflows/*.yml` or `*.yaml` under `top`, by file name; none
/// when there is no such directory.
///
/// # Errors
/// When the directory or a workflow cannot be read.
pub fn candidates(top: &Path) -> std::io::Result<Vec<Candidate>> {
    let dir = top.join(".github/workflows");
    let mut files = match std::fs::read_dir(&dir) {
        Ok(d) => d
            .map(|e| e.map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect::<std::io::Result<Vec<String>>>()?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    files.retain(|f| f.ends_with(".yml") || f.ends_with(".yaml"));
    files.sort();
    let mut out = Vec::new();
    for f in files {
        let text = std::fs::read_to_string(dir.join(&f))?;
        out.extend(candidates_in(&format!(".github/workflows/{f}"), &text));
    }
    Ok(out)
}
