//! Whether the code under a carried deferral is unchanged since its question was recorded, asked
//! of the scope check the memory sets a finding aside by, so a re-review carries it without an
//! adjudicator by the same anchor — its commit, else the merge of a pull request it links, else
//! its date (realm @nick/craft, nodes #680, #184, #682, #676).

use std::path::Path;

use serde_json::Value;

use super::PriorDecision;
use super::anchor::{pulls, today};
use super::priors::scope_check_on;
use crate::ledger::Deferral;

/// For each of `rows`, a deferral and the path of its row's finding, whether the scope check
/// finds that path unchanged since the deferral's anchor in `repo` — not missing, not unusable,
/// not changed on the trunk outside the pull request before its merge. The trunk and the origin
/// are asked of git once for all of them.
pub(crate) fn unchanged_deferrals(repo: &Path, rows: &[(&Deferral, &str)]) -> Vec<bool> {
    unchanged_on(repo, rows, &today())
}

/// [`unchanged_deferrals`] with `today` the UTC date.
fn unchanged_on(repo: &Path, rows: &[(&Deferral, &str)], today: &str) -> Vec<bool> {
    let records: Vec<PriorDecision> = rows
        .iter()
        .enumerate()
        .map(|(i, (d, scope))| record(i, d, scope))
        .collect();
    let refs: Vec<&PriorDecision> = records.iter().collect();
    let checked = scope_check_on(repo, &refs, today);
    records
        .iter()
        .map(|d| checked.unchanged.contains(&d.id))
        .collect()
}

/// The question record a deferral stands for, as far as its scope check reads it — its scope
/// `scope` and its anchors —, named by its place `i`: two rows may carry one question over
/// different files. A row written before its pull requests were carried names them by its `link`
/// alone.
fn record(i: usize, d: &Deferral, scope: &str) -> PriorDecision {
    let pulls = if d.pulls.is_empty() {
        pulls(&[Value::from(d.link.as_str())])
    } else {
        d.pulls.clone()
    };
    PriorDecision {
        id: i.to_string(),
        scope: scope.to_owned(),
        when: d.when.clone(),
        commit: d.commit.clone(),
        pulls,
        ..PriorDecision::default()
    }
}

#[cfg(test)]
mod tests;
