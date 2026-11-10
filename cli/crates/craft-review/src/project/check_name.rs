//! The check a job's `name:` is reported as (realm @nick/craft, node #482): GitHub expands each
//! `${{ … }}` in it per run, so the literal name never matches a run. Expressions inside a trailing
//! ` (…)` give runs named `<prefix> (…)`, which the matrix rule counts for `<prefix>`; any other
//! expanded name has no check a map entry can name, and is left to the reviewer with a note.

use super::candidates::Unresolved;
use super::shell::{cargo_sub, commands, hints, recipe};
use super::signal::Signal;
use super::workflow::Job;

const OPEN: &str = "${{";

/// Whether a check holds an expression GitHub would have expanded: no run is named so.
#[must_use]
pub fn unexpanded(check: &str) -> bool {
    check.contains(OPEN)
}

/// The check the job named `name` reports as: the name itself without an expression; with one,
/// the literal before the trailing ` (…)` that holds it; else why it has none.
pub(super) fn check_of(name: &str) -> Result<&str, String> {
    let Some((head, _)) = name.split_once(OPEN) else {
        return Ok(name);
    };
    let closed = name.trim_end().ends_with(')');
    let before = head
        .rsplit_once('(')
        .filter(|(b, inside)| closed && !inside.contains(')') && b.ends_with(' '));
    match before.map(|(b, _)| b.trim_end()) {
        Some(check) if !check.is_empty() => Ok(check),
        _ => Err(format!(
            "the job's `name:` {name:?} holds an expression GitHub expands in each run's name, outside a trailing ` (…)` after a literal part, so no check of the map matches its runs: leave it out, or give the job a name whose expressions sit in a trailing ` (…)`"
        )),
    }
}

/// The unresolved candidate of job `j` of `workflow`, named `name`, which has no check: its cargo
/// and recipe run lines and the signals they give or hint at, with `note`; none when it runs
/// neither.
pub(super) fn expanded(workflow: &str, j: &Job, name: &str, note: String) -> Option<Unresolved> {
    let cargo = |c: &str| cargo_sub(c).and_then(Signal::of_cargo);
    let runs: Vec<String> = j
        .runs
        .iter()
        .flat_map(|l| commands(l))
        .filter(|c| cargo(c).is_some() || recipe(c))
        .map(str::to_owned)
        .collect();
    let mut signals: Vec<Signal> = runs.iter().filter_map(|c| cargo(c)).collect();
    signals.extend(hints(&format!("{name} {}", runs.join(" "))));
    signals.sort_unstable();
    signals.dedup();
    (!runs.is_empty() && !signals.is_empty()).then(|| Unresolved {
        check: name.to_owned(),
        matrix: j.matrix,
        runs,
        hints: signals,
        workflow: workflow.to_owned(),
        uses: j.uses.clone(),
        note: Some(note),
    })
}
