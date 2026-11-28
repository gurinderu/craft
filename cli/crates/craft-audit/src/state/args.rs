//! What an audit is run with, kept in its state.

use serde::{Deserialize, Serialize};

/// What the binary files the run's record with: the craft plugin root its `craftCommit` is read
/// off ("" none) and the host session it names ("" none).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Recording {
    pub root: String,
    pub session: String,
}

/// What an audit is run with.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Args {
    /// The paths under the repository root it reads; none, the whole project.
    pub paths: Vec<String>,
    /// The bytes of whole files one lens agent reads at most, a larger file alone.
    pub batch_bytes: u64,
    /// The lens agents one pass buys at most; `None`, one of each lens over each batch.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lens_agents: Option<usize>,
    /// The craft release that runs it, for its record and the rubric paths its prompts name.
    pub craft_version: String,
    /// The craft plugin root its prompts find the skills under.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub craft_root: Option<String>,
    /// Where the binary files its record (`start --record`); none, and nothing is filed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record: Option<Recording>,
}
