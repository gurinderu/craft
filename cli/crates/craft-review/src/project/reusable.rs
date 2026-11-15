//! The jobs of the repository's workflows as GitHub reports them (realm @nick/craft, node #482): a
//! job that calls a reusable workflow by a `uses:` of its own has no run of its own — GitHub
//! reports each job of the called workflow as `<caller> / <job>`, a matrix caller's as
//! `<caller> (…) / <job>`, which no check of the map names —, and a workflow whose one trigger is
//! `workflow_call` runs only so, its jobs never under their own names. Each such job is read with
//! the name GitHub reports it by, so the map proposes, grounds and claims it as any other; a
//! called job reached only through a workflow of another repository, or through a chain of calls,
//! is not read.

use std::path::Path;

use super::check_name::unexpanded;
use super::ci_error::CiError;
use super::ci_ground::read;
use super::workflow::{Job, jobs, workflow_files};
use super::workflow_on::called_only;

/// A job of `workflow` under the name GitHub reports its runs by, and the workflow file of the job
/// that calls it, when it runs only through one.
#[derive(Debug, Clone)]
pub(super) struct Reported {
    pub workflow: String,
    pub job: Job,
    pub caller: Option<String>,
}

/// Whether job `c` calls the local workflow file `workflow`.
fn calls(c: &Job, workflow: &str) -> bool {
    c.calls.as_deref().and_then(|u| u.strip_prefix("./")) == Some(workflow)
}

/// Job `j` as GitHub reports it when the job `c` calls its workflow: `<caller> / <job>`, the
/// caller's name read as expanded when it runs a matrix.
fn through(c: &Job, j: &Job) -> Job {
    let caller = c.name.as_deref().unwrap_or(&c.id);
    let caller = if c.matrix && !unexpanded(caller) {
        format!("{caller} (${{{{ matrix }}}})")
    } else {
        caller.to_owned()
    };
    let name = j.name.as_deref().unwrap_or(&j.id);
    Job {
        name: Some(format!("{caller} / {name}")),
        ..j.clone()
    }
}

/// A job `c` of the workflow file it is in.
type Caller<'a> = (&'a str, &'a Job);

/// Job `j` of `workflow` as GitHub reports it: under its own name unless the workflow is `only`
/// called, and through each of `callers` that calls the workflow.
fn of_job(workflow: &str, only: bool, j: &Job, callers: &[Caller<'_>]) -> Vec<Reported> {
    let own = (!only).then(|| Reported {
        workflow: workflow.to_owned(),
        job: j.clone(),
        caller: None,
    });
    let called = callers
        .iter()
        .filter(|(_, c)| calls(c, workflow))
        .map(|(f, c)| Reported {
            workflow: workflow.to_owned(),
            job: through(c, j),
            caller: Some((*f).to_owned()),
        });
    own.into_iter().chain(called).collect()
}

/// The jobs of the workflow `files` (path, text) as GitHub reports them, file by file: a calling
/// job none, a called one through each job that calls its workflow.
pub(super) fn reported(files: &[(String, String)]) -> Vec<Reported> {
    let read: Vec<(&str, bool, Vec<Job>)> = files
        .iter()
        .map(|(f, t)| (f.as_str(), called_only(t), jobs(t)))
        .collect();
    let callers: Vec<Caller<'_>> = read
        .iter()
        .flat_map(|(f, _, js)| js.iter().filter(|j| j.calls.is_some()).map(|j| (*f, j)))
        .collect();
    read.iter()
        .flat_map(|(f, only, js)| {
            js.iter()
                .filter(|j| j.calls.is_none())
                .flat_map(|j| of_job(f, *only, j, &callers))
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
