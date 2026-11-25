//! What git observed of a run's records, kept between its steps so each is asked once.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use craft_review::memory::{PriorDecision, Scope, git_scope};
use serde::{Deserialize, Serialize};

/// What git observed of the records' scopes, each record checked once: those whose scope is
/// unchanged since their anchor, those whose anchor the repository holds no commit for, and why
/// where that is other than missing.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Seen {
    pub checked: BTreeSet<String>,
    pub unchanged: BTreeSet<String>,
    pub missing: BTreeSet<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub why_missing: BTreeMap<String, String>,
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
        }
        let of = |set: &BTreeSet<String>| {
            ds.iter()
                .filter(|d| set.contains(&d.id))
                .map(|d| d.id.clone())
                .collect()
        };
        Scope {
            unchanged: of(&self.unchanged),
            missing: of(&self.missing),
            why_missing: self
                .why_missing
                .iter()
                .filter(|(id, _)| ds.iter().any(|d| &d.id == *id))
                .map(|(id, why)| (id.clone(), why.clone()))
                .collect(),
        }
    }
}
