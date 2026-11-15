//! The jobs of the repository's workflows as GitHub reports them (realm @nick/craft, node #482): a
//! job that calls a reusable workflow by a `uses:` of its own has no run of its own — GitHub
//! reports each job of the called workflow as `<caller> / <job>`, through a chain of calls as
//! `<caller> / <caller> / <job>`, a matrix caller's as `<caller> (…) / <job>`, which no check of the
//! map names —, and a workflow whose one trigger is `workflow_call` runs only so, its jobs never
//! under their own names. Each such job is read with the name GitHub reports it by, so the map
//! proposes, grounds and claims it as any other; a called job reached only through a workflow of
//! another repository is not read, nor a chain deeper than GitHub allows.

use std::path::Path;

use super::check_name::unexpanded;
use super::ci_error::CiError;
use super::ci_ground::read;
use super::workflow::{Job, jobs, workflow_files};
use super::workflow_on::called_only;

/// A job of `workflow` under the name GitHub reports its runs by, and the workflow files of the
/// chain of jobs that calls it, when it runs through one.
#[derive(Debug, Clone)]
pub(super) struct Reported {
    pub workflow: String,
    pub job: Job,
    pub callers: Vec<String>,
}

/// A workflow file read: its path, whether it only runs when called, its jobs.
type Read<'a> = (&'a str, bool, Vec<Job>);

/// The deepest chain of calls GitHub runs: a top-level workflow and nine nested ones.
const DEPTH: usize = 10;

/// Whether job `c` calls the local workflow file `workflow`.
fn calls(c: &Job, workflow: &str) -> bool {
    c.calls.as_deref().and_then(|u| u.strip_prefix("./")) == Some(workflow)
}

/// The name of calling job `c` in a reported one, read as expanded when it runs a matrix.
fn caller_name(c: &Job) -> String {
    let caller = c.name.as_deref().unwrap_or(&c.id);
    if c.matrix && !unexpanded(caller) {
        format!("{caller} (${{{{ matrix }}}})")
    } else {
        caller.to_owned()
    }
}

/// Each chain of calling jobs through which GitHub runs `workflow`: the names it prefixes a called
/// job with (`<caller> / … `), and the workflow files the chain runs through.
fn chains(workflow: &str, read: &[Read<'_>], depth: usize) -> Vec<(String, Vec<String>)> {
    if depth >= DEPTH {
        return Vec::new();
    }
    let mut out = Vec::new();
    for (f, only, js) in read {
        for c in js.iter().filter(|c| calls(c, workflow)) {
            let me = caller_name(c);
            if !only {
                out.push((me.clone(), vec![(*f).to_owned()]));
            }
            for (above, mut files) in chains(f, read, depth + 1) {
                files.push((*f).to_owned());
                out.push((format!("{above} / {me}"), files));
            }
        }
    }
    out
}

/// Job `j` of `workflow` as GitHub reports it: under its own name unless the workflow is `only`
/// called, and as `<chain> / <job>` through each chain of calls that runs the workflow.
fn of_job(workflow: &str, only: bool, j: &Job, read: &[Read<'_>]) -> Vec<Reported> {
    let name = j.name.as_deref().unwrap_or(&j.id);
    let own = (!only).then(|| Reported {
        workflow: workflow.to_owned(),
        job: j.clone(),
        callers: Vec::new(),
    });
    let called = chains(workflow, read, 1)
        .into_iter()
        .map(|(chain, callers)| Reported {
            workflow: workflow.to_owned(),
            job: Job {
                name: Some(format!("{chain} / {name}")),
                ..j.clone()
            },
            callers,
        });
    own.into_iter().chain(called).collect()
}

/// The jobs of the workflow `files` (path, text) as GitHub reports them, file by file: a calling
/// job none, a called one through each chain of calls that runs its workflow.
pub(super) fn reported(files: &[(String, String)]) -> Vec<Reported> {
    let read: Vec<Read<'_>> = files
        .iter()
        .map(|(f, t)| (f.as_str(), called_only(t), jobs(t)))
        .collect();
    read.iter()
        .flat_map(|(f, only, js)| {
            js.iter()
                .filter(|j| j.calls.is_none())
                .flat_map(|j| of_job(f, *only, j, &read))
        })
        .collect()
}

/// Every workflow under `top`, `workflow` among them, with its text.
pub(super) fn read_all(top: &Path, workflow: &str) -> Result<Vec<(String, String)>, CiError> {
    let unlisted = |error| CiError::Unreadable {
        path: ".github/workflows".to_owned(),
        error,
    };
    let mut files = workflow_files(top).map_err(unlisted)?;
    if !files.iter().any(|f| f == workflow) {
        files.push(workflow.to_owned());
    }
    files
        .into_iter()
        .map(|f| read(top, &f).map(|t| (f, t)))
        .collect()
}

/// The jobs of `units` in `workflow`.
pub(super) fn jobs_of(units: &[Reported], workflow: &str) -> Vec<Job> {
    units
        .iter()
        .filter(|u| u.workflow == workflow)
        .map(|u| u.job.clone())
        .collect()
}
