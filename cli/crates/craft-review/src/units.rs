//! Unit mode (`unitScope`; realm @nick/craft, transformation #324): off by default and asked for
//! per run (#362). The binary discovers the units of each profile that has them — the Rust
//! profile's Cargo packages — cuts the change into unit batches by the unit graph within a volume
//! budget (#355), and the rounds run each code-intrinsic lens confined to one batch, with the
//! contract lens of each touched unit beside the first round (#327); after the rounds a coordinator
//! answers the questions the confined lenses left in their answers, decides each finding that
//! depends on one, and judges the seam between the units (#315, #321). Where the mode cannot run the
//! review runs in the normal mode, with one warning line saying why — never a coverage hole.

pub mod batch;
mod coordinator;
pub mod dirs;
pub mod discover;
pub mod graph;
mod open;
mod report;
pub mod scope;
pub mod seam;
mod tasks;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use coordinator::{seam_answered, seam_tasks};
pub use open::open;
pub use report::{NOT_RUN, section};
pub use tasks::{contract_tasks, keep_questions};

/// One part of the change a lens agent judges: a batch of units, or a directory slice of files in
/// no unit (`units` empty). `files` carries the shared ones (manifests, lockfiles) too.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Slice {
    pub key: String,
    pub files: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub units: Vec<String>,
}

impl Slice {
    /// A directory slice of files in no unit.
    #[must_use]
    pub fn loose(key: String, files: Vec<String>) -> Self {
        Self {
            key,
            files,
            units: Vec::new(),
        }
    }
}

/// What the coordinator after the lens round did (the engine's seam pass).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Seam {
    pub findings: usize,
    pub answered: u64,
    pub dispositions: seam::Counts,
    pub set_aside: Vec<seam::SetAside>,
}

/// One profile's part under unit mode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitTrack {
    pub profile: String,
    /// The batches and directory slices its sliceable lenses run over, one agent each.
    pub slices: Vec<Slice>,
    /// The units the change touches, sorted: one contract lens each, and the seam between them.
    pub units: Vec<String>,
    /// The questions its confined lenses asked about other units, each with the lens that asked.
    #[serde(default)]
    pub questions: Vec<Value>,
    /// The coordinator's outcome, once it answered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seam: Option<Seam>,
}

/// A run's unit mode. Optional in the state, so a state written before it reads as the mode off.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Units {
    /// Whether the run asked for unit mode.
    #[serde(default)]
    pub asked: bool,
    /// The profiles it is in effect for.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tracks: Vec<UnitTrack>,
    /// Why it is not in effect for a profile that took part, one warning line each.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notices: Vec<String>,
}

impl Units {
    /// The unit track of `profile`, when the mode is in effect for it.
    #[must_use]
    pub fn track(&self, profile: &str) -> Option<&UnitTrack> {
        self.tracks.iter().find(|t| t.profile == profile)
    }

    /// The slices `profile`'s sliceable lenses run over; none, unsliced.
    #[must_use]
    pub fn slices(&self, profile: &str) -> &[Slice] {
        self.track(profile).map_or(&[], |t| t.slices.as_slice())
    }
}

#[cfg(test)]
mod tests;
