//! What a CI map entry's coverage is found in (realm @nick/craft, node #482): its command spelled
//! in a `run:` line of the job its check names or in one of its sources, and each local `uses:`
//! that job runs among its sources. Checked when an entry is confirmed and whenever the gate would
//! trust it, so an entry edited after its files were hashed is never read as coverage.

use std::path::Path;

use super::ci_error::CiError;
use super::shell::joined;
use super::workflow::{Job, jobs};

fn read(top: &Path, path: &str) -> Result<String, CiError> {
    std::fs::read_to_string(top.join(path)).map_err(|error| CiError::Unreadable {
        path: path.to_owned(),
        error,
    })
}

/// The jobs of the workflow `text` that `check` names — its `name:` (or id), a matrix job's
/// `<name> (…)` runs too —, every job when none is named so.
fn checked_jobs(text: &str, check: &str) -> Vec<Job> {
    let all = jobs(text);
    let named = |j: &Job| {
        let n = j.name.as_deref().unwrap_or(&j.id);
        n == check || check.strip_prefix(n).is_some_and(|r| r.starts_with(" ("))
    };
    if all.iter().any(named) {
        all.into_iter().filter(named).collect()
    } else {
        all
    }
}

/// `s` with each run of whitespace one space.
fn squeezed(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Refuses a local `uses: ./…` of `mine` (a composite action, a reusable workflow) that none of
/// `sources` is or lies under.
fn local_uses_listed(mine: &[Job], check: &str, sources: &[String]) -> Result<(), CiError> {
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

/// Whether `command`, whitespace aside, is in a line of `text` (its `\` continuations joined).
fn spelled_in(text: &str, command: &str) -> bool {
    let lines: Vec<&str> = text.lines().map(str::trim).collect();
    joined(&lines).iter().any(|l| squeezed(l).contains(command))
}

/// Refuses an entry whose workflow, read under `top`, runs a local `uses:` its sources do not
/// list, or whose command, whitespace aside, is neither in a `run:` line of the jobs `check`
/// names nor in a line of one of its sources.
pub(super) fn grounded(
    top: &Path,
    workflow: &str,
    check: &str,
    command: &str,
    sources: &[String],
) -> Result<(), CiError> {
    let mine = checked_jobs(&read(top, workflow)?, check);
    local_uses_listed(&mine, check, sources)?;
    let want = squeezed(command);
    if mine
        .iter()
        .flat_map(|j| &j.runs)
        .any(|l| squeezed(l).contains(&want))
    {
        return Ok(());
    }
    for s in sources {
        if spelled_in(&read(top, s)?, &want) {
            return Ok(());
        }
    }
    Err(CiError::Unfound {
        check: check.to_owned(),
        command: command.to_owned(),
        workflow: workflow.to_owned(),
    })
}
