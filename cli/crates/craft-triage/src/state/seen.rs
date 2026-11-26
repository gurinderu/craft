//! What git observed of a run's records, kept between its steps so each is asked once.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use craft_review::memory::{PriorDecision, Scope, git_scope};
use serde::{Deserialize, Serialize};

/// What git observed of the records' scopes, each record checked once: those whose scope is
/// unchanged since their anchor, those whose anchor the repository holds no commit for, why
/// where that is other than missing, the pull request whose merge a record was compared
/// against, and the records whose scope changed on the trunk between their date and that merge.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Seen {
    pub checked: BTreeSet<String>,
    pub unchanged: BTreeSet<String>,
    pub missing: BTreeSet<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub why_missing: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub merged: BTreeMap<String, u64>,
    #[serde(skip_serializing_if = "BTreeSet::is_empty")]
    pub between: BTreeSet<String>,
}

impl Seen {
    /// The scope of `ds`, git in `repo` asked only about the records not checked before.
    pub fn scope(&mut self, repo: &Path, ds: &[&PriorDecision]) -> Scope {
        let fresh: Vec<&PriorDecision> = ds
            .iter()
            .copied()
            .filter(|d| !self.checked.contains(&d.id))
            .collect();
        if !fresh.is_empty() {
            let s = git_scope(repo)(&fresh);
            self.checked.extend(fresh.iter().map(|d| d.id.clone()));
            self.unchanged.extend(s.unchanged);
            self.missing.extend(s.missing);
            self.why_missing.extend(s.why_missing);
            self.merged.extend(s.merged);
            self.between.extend(s.between);
        }
        let of = |set: &BTreeSet<String>| {
            ds.iter()
                .filter(|d| set.contains(&d.id))
                .map(|d| d.id.clone())
                .collect()
        };
        let given = |id: &String| ds.iter().any(|d| &d.id == id);
        Scope {
            unchanged: of(&self.unchanged),
            missing: of(&self.missing),
            why_missing: self
                .why_missing
                .iter()
                .filter(|(id, _)| given(id))
                .map(|(id, why)| (id.clone(), why.clone()))
                .collect(),
            merged: self
                .merged
                .iter()
                .filter(|(id, _)| given(id))
                .map(|(id, n)| (id.clone(), *n))
                .collect(),
            between: of(&self.between),
        }
    }
}
