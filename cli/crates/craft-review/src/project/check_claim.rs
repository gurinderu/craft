//! What a check claims among the jobs of every workflow of the repository (realm @nick/craft, node
//! #482): the gate counts each run named `<check>` or `<check> (…)` on the head, whatever workflow
//! ran it, so an entry is refused — at `--write`, and skipped by the gate — when a job other than
//! its own is reported so: one whose literal head (its name up to the first `${{`) starts with
//! `<check> (`, another job whose name reports as `<check>` that does not run the entry's command by
//! a `run:` line of its own (a source is read whole, so it cannot show which job calls it), or a job
//! GitHub expands into runs `<prefix> (…)` — a `${{` in its trailing ` (…)`, or a matrix under a
//! literal name — beside a job reported as `<check>` itself. Without such a job, a check under a
//! job's expanded runs names one of them, whose other runs it would never see. `--propose` leaves a
//! colliding candidate of one workflow unresolved, with the refusal as its note.

use std::path::Path;

use super::check_name::{OPEN, check_of, unexpanded};
use super::ci_error::CiError;
use super::ci_ground::read;
use super::ci_match::runs_in;
use super::workflow::{Job, jobs, workflow_files};

/// A job and the workflow file it is in.
pub(super) type Placed<'a> = (&'a str, &'a Job);

fn name(j: &Job) -> &str {
    j.name.as_deref().unwrap_or(&j.id)
}

/// `j`'s name up to its first expression: the literal part every run's name begins with.
fn head(j: &Job) -> &str {
    name(j).split_once(OPEN).map_or(name(j), |(h, _)| h)
}

/// Whether GitHub reports `j`'s runs as `check`.
fn reports(j: &Job, check: &str) -> bool {
    check_of(name(j)).is_ok_and(|c| c == check)
}

/// The prefix of `j`'s runs when GitHub expands it into runs `<prefix> (…)`: a `${{` in its
/// trailing ` (…)`, or a matrix under a literal name.
fn spread(j: &Job) -> Option<&str> {
    let n = name(j);
    if unexpanded(n) {
        check_of(n).ok()
    } else {
        j.matrix.then_some(n)
    }
}

/// The job other than `check`'s own whose runs the gate would count for it, as the refusal.
pub(super) fn collision(all: &[Placed<'_>], check: &str, command: &str) -> Option<CiError> {
    let matrix = format!("{check} (");
    let refusal =
        |&(workflow, j): &Placed<'_>| (check.to_owned(), name(j).to_owned(), workflow.to_owned());
    if let Some(p) = all
        .iter()
        .find(|(_, j)| !reports(j, check) && head(j).starts_with(&matrix))
    {
        let (check, job, workflow) = refusal(p);
        return Some(CiError::Sibling {
            check,
            job,
            workflow,
        });
    }
    let same: Vec<&Placed<'_>> = all.iter().filter(|(_, j)| reports(j, check)).collect();
    let runs = |j: &Job| j.runs.iter().any(|l| runs_in(l, command));
    let stray = same
        .iter()
        .find(|(_, j)| !runs(j))
        .filter(|_| same.len() > 1);
    stray.map(|p| {
        let (check, job, workflow) = refusal(p);
        CiError::Shared {
            check,
            job,
            workflow,
        }
    })
}

/// The refusal of a `check` under a job's expanded runs `<prefix> (…)`: one run of it, or — beside
/// a job reported as `check` itself — a collision with it.
fn one_run(all: &[Placed<'_>], check: &str) -> Option<CiError> {
    let under = |p: &str| check.strip_prefix(p).is_some_and(|r| r.starts_with(" ("));
    let &(workflow, j) = all.iter().find(|(_, j)| spread(j).is_some_and(under))?;
    let (check, job, workflow) = (check.to_owned(), name(j).to_owned(), workflow.to_owned());
    if all.iter().any(|(_, o)| reports(o, &check)) {
        return Some(CiError::Sibling {
            check,
            job,
            workflow,
        });
    }
    let prefix = spread(j).unwrap_or_default().to_owned();
    Some(CiError::OneRun {
        check,
        job,
        workflow,
        prefix,
    })
}

/// Refuses an entry of `workflow` whose `check` names one expanded run, or collides with another
/// job, for its `command`, of any workflow under `top`.
pub(super) fn claimed(
    top: &Path,
    workflow: &str,
    check: &str,
    command: &str,
) -> Result<(), CiError> {
    let unlisted = |error| CiError::Unreadable {
        path: ".github/workflows".to_owned(),
        error,
    };
    let mut files = workflow_files(top).map_err(unlisted)?;
    if !files.iter().any(|f| f == workflow) {
        files.push(workflow.to_owned());
    }
    let read_all: Vec<(String, Vec<Job>)> = files
        .into_iter()
        .map(|f| read(top, &f).map(|t| (f, jobs(&t))))
        .collect::<Result<_, _>>()?;
    let all: Vec<Placed<'_>> = read_all
        .iter()
        .flat_map(|(f, js)| js.iter().map(move |j| (f.as_str(), j)))
        .collect();
    one_run(&all, check)
        .or_else(|| collision(&all, check, command))
        .map_or(Ok(()), Err)
}
