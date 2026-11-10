//! What a check claims among the jobs of its workflow (realm @nick/craft, node #482): the gate
//! counts each run named `<check>` or `<check> (…)` for an entry, so `--write` refuses an entry
//! when a job other than its own is reported so — one whose literal head (its name up to the first
//! `${{`) starts with `<check> (`, or another job whose name reports as `<check>` that does not run
//! the entry's command by a `run:` line of its own (a source is read whole, so it cannot show
//! which job calls it) — and when its check names one expanded run of a job whose name holds `${{`
//! in its trailing ` (…)`, whose other runs it would never see. `--propose` leaves a colliding
//! candidate unresolved, with the refusal as its note.

use std::path::Path;

use super::candidates::{Candidate, Resolved, Unresolved};
use super::check_name::{OPEN, check_of, unexpanded};
use super::ci_error::CiError;
use super::ci_ground::read;
use super::ci_match::runs_in;
use super::workflow::{Job, jobs};

fn name(j: &Job) -> &str {
    j.name.as_deref().unwrap_or(&j.id)
}

/// `j`'s name up to its first expression: the literal part every run's name begins with.
fn head(j: &Job) -> &str {
    name(j).split_once(OPEN).map_or(name(j), |(h, _)| h)
}

/// The job other than `check`'s own whose runs the gate would count for it, as the refusal.
fn collision(all: &[Job], check: &str, command: &str) -> Option<CiError> {
    let matrix = format!("{check} (");
    let reports = |j: &Job| check_of(name(j)).is_ok_and(|c| c == check);
    if let Some(j) = all
        .iter()
        .find(|j| !reports(j) && head(j).starts_with(&matrix))
    {
        return Some(CiError::Sibling {
            check: check.to_owned(),
            job: name(j).to_owned(),
        });
    }
    let same: Vec<&Job> = all.iter().filter(|j| reports(j)).collect();
    let runs = |j: &Job| j.runs.iter().any(|l| runs_in(l, command));
    let stray = same.iter().find(|j| !runs(j)).filter(|_| same.len() > 1);
    stray.map(|j| CiError::Shared {
        check: check.to_owned(),
        job: name(j).to_owned(),
    })
}

/// The refusal of a `check` that names one expanded run of a job whose name GitHub expands.
fn one_run(all: &[Job], check: &str) -> Option<CiError> {
    all.iter().find_map(|j| {
        let n = name(j);
        let prefix = check_of(n).ok().filter(|_| unexpanded(n))?;
        let one = check
            .strip_prefix(prefix)
            .is_some_and(|r| r.starts_with(" ("));
        one.then(|| CiError::OneRun {
            check: check.to_owned(),
            job: n.to_owned(),
            prefix: prefix.to_owned(),
        })
    })
}

/// Refuses an entry whose `check` names one expanded run, or collides with another job of its
/// `workflow` read under `top`, for its `command`.
pub(super) fn claimed(
    top: &Path,
    workflow: &str,
    check: &str,
    command: &str,
) -> Result<(), CiError> {
    let all = jobs(&read(top, workflow)?);
    one_run(&all, check)
        .or_else(|| collision(&all, check, command))
        .map_or(Ok(()), Err)
}

/// `found`, each resolved candidate that collides with another job of `all` left unresolved.
pub(super) fn unclaimed(all: &[Job], found: Vec<Candidate>) -> Vec<Candidate> {
    let one = |c| match c {
        Candidate::Resolved(r) => match collision(all, &r.check, &r.command) {
            Some(e) => Candidate::Unresolved(collided(r, e.to_string())),
            None => Candidate::Resolved(r),
        },
        u @ Candidate::Unresolved(_) => u,
    };
    found.into_iter().map(one).collect()
}

/// The unresolved form of resolved `r`, `why` it collides leading its note.
fn collided(r: Resolved, why: String) -> Unresolved {
    let note = match r.note {
        Some(n) => format!("{why}; {n}"),
        None => why,
    };
    Unresolved {
        check: r.check,
        matrix: r.matrix,
        runs: vec![r.command],
        hints: vec![r.signal],
        workflow: r.workflow,
        uses: r.uses,
        note: Some(note),
    }
}
