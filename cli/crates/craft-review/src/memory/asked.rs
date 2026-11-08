//! What a memory judge was asked, kept in the run's state from the step that hands its task out to
//! the step that reads its answer: the answer is read against the very pairs it was asked about,
//! and the scope check git ran for them is not run again.

use std::collections::BTreeSet;

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
/// commit, those whose commit the repository lacks, and the (finding, record) pairs asked.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MatchAsked {
    pub unchanged: BTreeSet<String>,
    pub missing: BTreeSet<String>,
    pub pairs: Vec<(usize, usize)>,
}
