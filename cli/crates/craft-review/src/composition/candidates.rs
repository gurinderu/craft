//! What `craft init --propose` shows the reviewer of the lenses on a project (realm @nick/craft,
//! node #647): each lens's yield over the project's runs, and the lenses its numbers alone offer to
//! hold to the first round or turn off.

use std::collections::BTreeMap;

use craft_store::record::SEVERITIES;
use craft_store::retro::Lens;
use serde::Serialize;

use super::{Composition, State};
use crate::profile::Profile;

/// The passes a lens has had on the project before its yield may offer it.
pub const PASSES: u64 = 20;

/// The severities a confirmed finding of which keeps a lens from being offered.
const KEEPS: [&str; 3] = ["Critical", "High", "Medium"];

/// One lens's yield on the project: the runs it went in, the runs it was planned for and did not
/// run, and its confirmed findings by severity.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Yield {
    pub lens: String,
    pub runs: u64,
    pub dead: u64,
    pub confirmed: BTreeMap<String, f64>,
}

/// A lens its yield offers, with the states the reviewer may confirm for it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Candidate {
    pub lens: String,
    pub runs: u64,
    pub states: Vec<State>,
}

/// Each `profile:lens` of `lenses` — a retro's, whose rows of the CLI's runs carry ` (cli)` — summed
/// once under its own name; a row naming no profile, an engine's before the CLI, is passed over.
#[must_use]
pub fn yields(lenses: &BTreeMap<String, Lens>) -> Vec<Yield> {
    let mut by: BTreeMap<&str, Lens> = BTreeMap::new();
    for (name, l) in lenses {
        let name = name.trim_end_matches(" (cli)");
        if !name.contains(':') {
            continue;
        }
        let sum = by.entry(name).or_default();
        sum.runs += l.runs;
        sum.dead += l.dead;
        for (s, v) in sum.by_severity.iter_mut().zip(l.by_severity) {
            *s += v;
        }
    }
    by.into_iter()
        .map(|(lens, l)| Yield {
            lens: lens.to_owned(),
            runs: l.runs,
            dead: l.dead,
            confirmed: SEVERITIES
                .iter()
                .zip(l.by_severity)
                .map(|(s, v)| ((*s).to_owned(), v))
                .collect(),
        })
        .collect()
}

/// The lenses of `yields` with [`PASSES`] passes or more and no confirmed Medium or above, each
/// with the states the review would take for it in `profiles` — none for the security lens or a
/// safety lens, only the first round for the concurrency lens — and one with no such state left
/// out.
#[must_use]
pub fn candidates(yields: &[Yield], profiles: &[Profile]) -> Vec<Candidate> {
    yields
        .iter()
        .filter(|y| y.runs >= PASSES)
        .filter(|y| {
            KEEPS
                .iter()
                .all(|s| y.confirmed.get(*s).is_none_or(|n| *n <= 0.0))
        })
        .filter_map(|y| {
            let states: Vec<State> = [State::FirstRound, State::Off]
                .into_iter()
                .filter(|s| Composition::of(&[(y.lens.clone(), *s)], profiles).is_ok())
                .collect();
            (!states.is_empty()).then(|| Candidate {
                lens: y.lens.clone(),
                runs: y.runs,
                states,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests;
