//! `cargo xtask gate-steps`: the gate is complete — every check package.json, integrations/shared/check-*.mjs, CI's
//! `test` job, AGENTS.md "Commands" and the justfile name is a gate step or excluded with its reason.

use std::io::{self, Write};

use crate::allowlist;
use crate::coverage::{self, Report};
use crate::justfile::{self, Recipe};
use crate::keys::Keys;
use crate::sources::Repo;

/// The recipe `just gate` runs.
const ENTRY: &str = "gate";

/// The names just itself lists (`just --summary --unsorted`) against the ones read here: a mismatch means the
/// reader missed or invented a recipe, and every other verdict would rest on it.
pub fn summary_mismatch(read: &[Recipe], summary: &str) -> Option<String> {
    let listed: Vec<&str> = summary.split_whitespace().collect();
    let parsed: Vec<&str> = read.iter().map(|r| r.name.as_str()).collect();
    (listed != parsed)
        .then(|| format!("just lists the recipes {listed:?}, this reader read {parsed:?}"))
}

/// Checks `repo` against `excluded`; `Ok(true)` when the gate is complete.
pub fn check(
    repo: &Repo,
    excluded: &[(&str, &str)],
    summary: &str,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> io::Result<bool> {
    let keys = match Keys::new(&repo.scripts) {
        Ok(keys) => keys,
        Err(e) => {
            writeln!(err, "gate-steps: {e}")?;
            return Ok(false);
        }
    };
    let required = repo.required(&keys);
    let steps = justfile::gate_steps(&repo.recipes);
    let mut report = coverage::check(&required, excluded, &steps, &keys);
    // The `gate` recipe runs the runner: what could hide its failure hides the whole gate's.
    let entry = repo.recipes.iter().filter(|r| r.name == ENTRY);
    report.refused.extend(entry.flat_map(allowlist::recipe));
    report
        .refused
        .extend(allowlist::directives(&repo.directives));
    let mismatch = summary_mismatch(&repo.recipes, summary);
    if report.is_clean() && mismatch.is_none() {
        writeln!(
            out,
            "gate-steps: {} named checks, each one of the {} gate steps or excluded with its reason",
            required.len(),
            steps.len()
        )?;
        return Ok(true);
    }
    if let Some(m) = mismatch {
        writeln!(err, "gate-steps: {m}")?;
    }
    print(&report, err)?;
    Ok(false)
}

fn print(report: &Report, err: &mut dyn Write) -> io::Result<()> {
    for key in &report.uncovered {
        writeln!(err, "gate-steps: not a gate step and not excluded: {key}")?;
    }
    for key in &report.stale {
        writeln!(err, "gate-steps: an exclusion naming no check: {key}")?;
    }
    for name in &report.repeated {
        writeln!(err, "gate-steps: a step named twice: {name}")?;
    }
    for name in &report.redundant {
        writeln!(
            err,
            "gate-steps: a step covering no named check another step does not: {name}"
        )?;
    }
    for line in &report.refused {
        writeln!(err, "gate-steps: outside the gate's form: {line}")?;
    }
    if report.no_steps {
        writeln!(
            err,
            "gate-steps: the justfile has no recipe in the gate group"
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
