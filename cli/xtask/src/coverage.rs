//! Is the gate complete? Every check the repository names is a step or excluded with its reason, every exclusion
//! names a check that exists, no step repeats, and dropping any one step leaves a named check uncovered.

use std::collections::BTreeSet;

use crate::justfile::Recipe;
use crate::keys::Keys;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Report {
    /// Named checks neither a step nor excluded.
    pub uncovered: Vec<String>,
    /// Exclusions naming no check.
    pub stale: Vec<String>,
    /// Steps named twice.
    pub repeated: Vec<String>,
    /// Steps covering nothing another step does not.
    pub redundant: Vec<String>,
    pub no_steps: bool,
}

impl Report {
    pub fn is_clean(&self) -> bool {
        *self == Self::default()
    }
}

/// What a step covers: its own recipe, what its body names, and what a script its body names names.
fn covers(step: &Recipe, keys: &Keys) -> BTreeSet<String> {
    let ran = keys.of(&step.body_text());
    let mut out: BTreeSet<String> = ran
        .iter()
        .filter_map(|k| k.strip_prefix("script:"))
        .flat_map(|script| keys.of_script(script))
        .collect();
    out.extend(ran);
    out.insert(format!("recipe:{}", step.name));
    out
}

pub fn check(
    required: &BTreeSet<String>,
    excluded: &[(&str, &str)],
    steps: &[Recipe],
    keys: &Keys,
) -> Report {
    let is_excluded = |k: &String| excluded.iter().any(|(e, _)| e == k);
    let sets: Vec<BTreeSet<String>> = steps.iter().map(|s| covers(s, keys)).collect();
    let open: Vec<&String> = required.iter().filter(|k| !is_excluded(k)).collect();
    let uncovered = open
        .iter()
        .filter(|k| !sets.iter().any(|s| s.contains(**k)))
        .map(|k| (*k).clone())
        .collect();
    let stale = excluded
        .iter()
        .filter(|(k, _)| !required.contains(*k))
        .map(|(k, _)| (*k).to_owned())
        .collect();
    let mut seen = BTreeSet::new();
    let repeated = steps
        .iter()
        .filter(|s| !seen.insert(s.name.as_str()))
        .map(|s| s.name.clone())
        .collect();
    let redundant = steps
        .iter()
        .zip(&sets)
        .enumerate()
        .filter(|(i, (step, set))| {
            let own = format!("recipe:{}", step.name);
            !open.iter().any(|k| {
                **k != own
                    && set.contains(*k)
                    && !sets
                        .iter()
                        .enumerate()
                        .any(|(j, other)| j != *i && other.contains(*k))
            })
        })
        .map(|(_, (step, _))| step.name.clone())
        .collect();
    Report {
        uncovered,
        stale,
        repeated,
        redundant,
        no_steps: steps.is_empty(),
    }
}

#[cfg(test)]
mod tests;
