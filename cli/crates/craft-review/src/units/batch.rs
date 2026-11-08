//! Unit batches (`batchByUnit` in `lib/unit-batches.mjs`; realm @nick/craft, #354, #355): the
//! touched units packed into batches of lens work under a volume budget. Units joined by a
//! dependency go together, so one agent sees the seam between them whole; a component over the
//! budget is grown along its edges; what is left, and the unconnected units, is bin-packed by
//! volume; a unit over the budget alone is split by module directory. Volume is a unit's changed
//! lines plus the public-signature lines of the discovered units it depends on. Every order here is
//! sorted, so one input gives one plan.

use std::collections::BTreeMap;

use super::Slice;
use super::dirs::partition_owned;
use super::graph::{Package, dep_sig_lines};
use super::scope::{UNIT_MIN_FILES, loose_groups, unit_of};
use groups::batch_groups;
use pack::module_units;

mod groups;
mod pack;

/// The volume budget a batch is cut at: the middle of the engine's candidate budgets (#355).
pub const BATCH_BUDGET: u64 = 1500;
/// The changed lines assumed for a file the numstat did not list.
const LINES_PER_FILE: u64 = 60;

/// What batching reads beside the files: the units, their graph and the changed lines by file.
pub struct Graph<'a> {
    pub roots: &'a [String],
    pub packages: &'a [Package],
    pub numstat: &'a BTreeMap<String, u64>,
}

impl Graph<'_> {
    fn lines(&self, f: &str) -> u64 {
        self.numstat.get(f).copied().unwrap_or(LINES_PER_FILE)
    }

    fn lines_of(&self, fs: &[String]) -> u64 {
        fs.iter().map(|f| self.lines(f)).sum()
    }
}

/// The batches of a unit-mode review, files in no unit kept on the directory slicing; empty — "do
/// not slice" — with fewer owned files than [`UNIT_MIN_FILES`], or no unit and one directory slice.
#[must_use]
pub fn batch_by_unit(
    files: &[String],
    g: &Graph<'_>,
    budget: u64,
    owns: &dyn Fn(&str) -> bool,
) -> Vec<Slice> {
    let (shared, owned) = partition_owned(files, owns);
    if owned.len() < UNIT_MIN_FILES {
        return Vec::new();
    }
    let mut by_unit: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut loose = Vec::new();
    for f in owned {
        match unit_of(&f, g.roots) {
            Some(u) => by_unit.entry(u).or_default().push(f),
            None => loose.push(f),
        }
    }
    let files_of = |r: &str| by_unit.get(r).cloned().unwrap_or_default();
    let sig = |r: &str| dep_sig_lines(&[r.to_owned()], g.packages);
    let vol = |r: &str| g.lines_of(&files_of(r)) + sig(r);
    let units: Vec<String> = by_unit.keys().cloned().collect();
    let (small, large): (Vec<String>, Vec<String>) =
        units.into_iter().partition(|r| vol(r) <= budget);
    let batch = |members: Vec<String>, fs: Vec<String>, key: String| Slice {
        key,
        files: [fs, shared.clone()].concat(),
        units: members,
    };
    let mut groups: Vec<Slice> = batch_groups(&small, g, &vol, budget)
        .into_iter()
        .map(|m| {
            let key = m
                .iter()
                .map(|r| format!("unit:{r}"))
                .collect::<Vec<_>>()
                .join(" ");
            let fs = m.iter().flat_map(|r| files_of(r)).collect();
            batch(m, fs, key)
        })
        .collect();
    for r in large {
        let cap = budget.saturating_sub(sig(&r)).max(1);
        for (key, fs) in module_units(&r, &files_of(&r), g, cap) {
            groups.push(batch(vec![r.clone()], fs, key));
        }
    }
    groups.sort_by(|a, b| a.key.cmp(&b.key));
    let sliced = !groups.is_empty();
    let all: Vec<Slice> = groups
        .into_iter()
        .chain(loose_groups(&loose, &shared, owns))
        .collect();
    // One batch is still a boundary (the unit rule holds at its edge); only one directory slice is
    // "do not slice".
    if all.len() > 1 || sliced {
        all
    } else {
        Vec::new()
    }
}

#[cfg(test)]
mod tests;
