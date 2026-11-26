//! What a memory judge was asked, kept in the run's state from the step that hands its task out to
//! the step that reads its answer: the answer is read against the very pairs it was asked about,
//! and the scope check git ran for them is not run again.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

/// The judges' asked pairs, each stage's once it was prepared. Optional, so a state written
/// before it reads as one that asked nothing yet.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Asked {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched: Option<MatchAsked>,
    /// The rule stage: its (finding, rule) pairs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ruled: Option<Vec<(usize, usize)>>,
}

impl Asked {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// The match stage as it was prepared: the records git saw unchanged in their scope since their
/// anchor, those whose anchor the repository holds no commit for, why where that is other than
/// missing, the pull request whose merge a record was compared against, the records whose scope
/// changed on the trunk outside the pull request before that merge ([`super::Scope`]), and the (finding,
/// record) pairs asked.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MatchAsked {
    pub unchanged: BTreeSet<String>,
    pub missing: BTreeSet<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub why_missing: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub merged: BTreeMap<String, u64>,
    #[serde(skip_serializing_if = "BTreeSet::is_empty")]
    pub between: BTreeSet<String>,
    pub pairs: Vec<(usize, usize)>,
}
