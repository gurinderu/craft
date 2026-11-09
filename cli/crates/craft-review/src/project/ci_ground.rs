//! What a CI map entry's coverage is found in (realm @nick/craft, node #482): its command run, as a
//! whole command whose failure fails the line (`ci_match`), by a `run:` line of the job its check
//! names or by a line of one of its sources, comment lines aside, and each local `uses:` that job
//! runs among its sources. A source is read as a whole: which recipe of it the job calls is the
//! reviewer's to confirm. Checked when an entry is confirmed and whenever the gate would trust it,
//! so an entry edited after its files were hashed is never read as coverage.

use std::path::Path;

use super::ci_error::CiError;
use super::ci_match::runs_in;
use super::shell::joined;
use super::workflow::{Job, jobs, unquote};

fn read(top: &Path, path: &str) -> Result<String, CiError> {
    std::fs::read_to_string(top.join(path)).map_err(|error| CiError::Unreadable {
        path: path.to_owned(),
        error,
    })
}

/// The jobs of `workflow`'s `text` that `check` names — its `name:` (or id), a matrix job's
/// `<name> (…)` runs too —; refused when it names none.
fn checked_jobs(text: &str, workflow: &str, check: &str) -> Result<Vec<Job>, CiError> {
    let named = |j: &Job| {
        let n = j.name.as_deref().unwrap_or(&j.id);
        n == check || check.strip_prefix(n).is_some_and(|r| r.starts_with(" ("))
    };
    let mine: Vec<Job> = jobs(text).into_iter().filter(named).collect();
    if mine.is_empty() {
        return Err(CiError::NoJob {
            check: check.to_owned(),
            workflow: workflow.to_owned(),
        });
    }
    Ok(mine)
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
    let mine = checked_jobs(&read(top, workflow)?, workflow, check)?;
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
