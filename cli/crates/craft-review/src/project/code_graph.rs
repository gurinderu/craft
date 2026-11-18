//! The profile's `[code_graph]` section (realm @nick/craft, node #529): whether the code graph
//! answered when `craft init` asked, and which of its projects indexes this repository. A review
//! takes the graph's callers into its consumers list only when this says it can.

use serde::{Deserialize, Serialize};

/// The code graph `craft init` probed for one repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeGraph {
    /// The program asked, `codebase-memory-mcp`.
    pub tool: String,
    /// Whether it answered at all.
    pub available: bool,
    /// Its project indexing this repository; empty when none does.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub project: String,
    /// Why it cannot be used, a line; empty when it can.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
}

impl CodeGraph {
    /// Whether a review can ask it for callers.
    #[must_use]
    pub fn usable(&self) -> bool {
        self.available && !self.project.is_empty()
    }
}
