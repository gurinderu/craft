//! What a CI map entry's coverage is found in (realm @nick/craft, node #482): its command run, as a
//! whole command whose failure fails the line (`ci_match`), by a `run:` line of the job its check
//! names or by a line of one of its sources, comment lines aside, and each local `uses:` that job
//! runs among its sources. A job is named as GitHub reports it: a called one as `<caller> / <job>`. A source is read as a whole: which recipe of it the job calls is the
//! reviewer's to confirm. Checked when an entry is confirmed and whenever the gate would trust it,
//! so an entry edited after its files were hashed is never read as coverage.

use std::path::Path;

use super::check_name::check_of;
use super::ci_error::CiError;
use super::ci_match::runs_in;
use super::reusable::{Reported, read_all, reported};
use super::shell::joined;
use super::workflow::{Job, unquote};
use super::workflow_on::called_only;

pub(super) fn read(top: &Path, path: &str) -> Result<String, CiError> {
    std::fs::read_to_string(top.join(path)).map_err(|error| CiError::Unreadable {
        path: path.to_owned(),
        error,
    })
}

/// Whether `check` names job `j`'s runs: its `name:` (or id), a matrix job's `<name> (…)` runs
/// too, a `name:` GitHub expands read as the check it reports as.
fn names(j: &Job, check: &str) -> bool {
    let n = j.name.as_deref().unwrap_or(&j.id);
    let n = check_of(n).unwrap_or(n);
    n == check || check.strip_prefix(n).is_some_and(|r| r.starts_with(" ("))
}

/// The jobs of `workflow` under `top` that `check` names, read as GitHub reports them
/// (`reusable`); refused when it names none — naming the checks GitHub reports a workflow that
/// only runs when called by.
fn checked_jobs(top: &Path, workflow: &str, check: &str) -> Result<Vec<Reported>, CiError> {
    let files = read_all(top, workflow)?;
    let units: Vec<Reported> = reported(&files)
        .into_iter()
        .filter(|u| u.workflow == workflow)
        .collect();
    let (check, workflow) = (check.to_owned(), workflow.to_owned());
    let (mine, others): (Vec<Reported>, Vec<Reported>) =
        units.into_iter().partition(|u| names(&u.job, &check));
    if !mine.is_empty() {
        return Ok(mine);
    }
    let only = files.iter().any(|(f, t)| *f == workflow && called_only(t));
    if !only || others.is_empty() {
        return Err(CiError::NoJob { check, workflow });
    }
    let name = |u: &Reported| u.job.name.clone().unwrap_or_default();
    let reported: Vec<String> = others.iter().map(|u| format!("`{}`", name(u))).collect();
    Err(CiError::CalledAs {
        check,
        workflow,
        reported: reported.join(", "),
    })
}

/// The workflow files of the jobs through which GitHub runs the jobs of `workflow` that `check`
/// names: whether they run, and under which check, rests on them too.
pub(super) fn callers(top: &Path, workflow: &str, check: &str) -> Result<Vec<String>, CiError> {
    let units = checked_jobs(top, workflow, check)?;
    Ok(units.into_iter().filter_map(|u| u.caller).collect())
}

/// Refuses a local `uses: ./…` of `mine` (a composite action, a reusable workflow) that none of
/// `sources` is or lies under.
fn local_uses_listed(mine: &[&Job], check: &str, sources: &[String]) -> Result<(), CiError> {
    let listed = |u: &str| {
        sources
            .iter()
            .any(|s| s == u || s.starts_with(&format!("{u}/")))
    };
    match mine.iter().flat_map(|j| &j.uses).find(|u| !listed(u)) {
        Some(u) => Err(CiError::LocalUses {
            check: check.to_owned(),
            uses: u.clone(),
        }),
        None => Ok(()),
    }
}

/// A source line as shell: past a YAML `- ` and `run:` key (a composite action's step), unquoted.
fn shell_line(l: &str) -> &str {
    let l = l.strip_prefix("- ").map_or(l, str::trim_start);
    l.strip_prefix("run:").map_or(l, |v| unquote(v.trim()))
}

/// Whether a line of `text` (its `\` continuations joined, its comment lines left out) runs
/// `command`.
fn spelled_in(text: &str, command: &str) -> bool {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.starts_with('#'))
        .map(shell_line)
        .collect();
    joined(&lines).iter().any(|l| runs_in(l, command))
}

/// Refuses an entry whose check names no job of its workflow, read under `top`, whose job runs a
/// local `uses:` its sources do not list, or whose command is run neither by a `run:` line of
/// that job nor by a line of one of its sources.
pub(super) fn grounded(
    top: &Path,
    workflow: &str,
    check: &str,
    command: &str,
    sources: &[String],
) -> Result<(), CiError> {
    let units = checked_jobs(top, workflow, check)?;
    let mine: Vec<&Job> = units.iter().map(|u| &u.job).collect();
    local_uses_listed(&mine, check, sources)?;
    if mine
        .iter()
        .flat_map(|j| &j.runs)
        .any(|l| runs_in(l, command))
    {
        return Ok(());
    }
    for s in sources {
        if spelled_in(&read(top, s)?, command) {
            return Ok(());
        }
    }
    Err(CiError::Unfound {
        check: check.to_owned(),
        command: command.to_owned(),
        workflow: workflow.to_owned(),
    })
}
