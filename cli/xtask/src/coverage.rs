//! Is the gate complete? Every check the repository names is a step or excluded with its reason, every exclusion
//! names a check that exists, no step repeats, and dropping any one step leaves a named check uncovered.

use std::collections::BTreeSet;

use crate::allowlist;
use crate::allowlist::forms::Form;
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
    /// `step: why` of each gate step outside the gate's form (`crate::allowlist`).
    pub refused: Vec<String>,
    pub no_steps: bool,
}

impl Report {
    pub fn is_clean(&self) -> bool {
        *self == Self::default()
    }
}

/// What a step covers: its own recipe, and by its form alone the script it runs with what that script names, or
/// the xtask check it runs. A name anywhere else in the line covers nothing.
fn covers(step: &Recipe, keys: &Keys) -> BTreeSet<String> {
    let mut out = BTreeSet::from([format!("recipe:{}", step.name)]);
    let commands = step.commands();
    let Some(line) = commands.first().filter(|_| commands.len() == 1) else {
        return out;
    };
    match allowlist::forms::form(step, line, keys) {
        Ok(Form::Script(script)) => {
            out.insert(format!("script:{script}"));
            out.extend(keys.of_script(script));
        }
        Ok(Form::Xtask(check)) => {
            out.insert(format!("xtask:{check}"));
        }
        Ok(Form::Gate) | Err(_) => {}
    }
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
    let refused = steps
        .iter()
        .flat_map(|s| allowlist::recipe(s, keys))
        .collect();
    Report {
        uncovered,
        refused,
        stale,
        repeated,
        redundant,
        no_steps: steps.is_empty(),
    }
}

#[cfg(test)]
mod tests;
