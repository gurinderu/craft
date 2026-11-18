//! The profile's `[code_graph]` section (realm @nick/craft, node #529): whether the code graph
//! answered when `craft init` asked, and which of its projects indexes this repository. A review
//! takes the graph's callers into its consumers list only when this says it can.

use serde::{Deserialize, Serialize};

/// The code graph `craft init` probed for one repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeGraph {
    /// The program asked, `codebase-memory-mcp`.
    pub tool: String,
    /// What it said.
    #[serde(flatten)]
    pub state: GraphState,
}

/// What the code graph said when `craft init` asked it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum GraphState {
    /// It did not answer: missing, failing or too slow; why, a line.
    Unavailable { note: String },
    /// It answered, but none of its projects indexes this repository; why, a line.
    Unindexed { note: String },
    /// Its project indexing this repository.
    Indexed { project: String },
}

impl CodeGraph {
    /// A graph of `tool` whose `project` indexes the repository.
    #[must_use]
    pub fn indexed(tool: &str, project: &str) -> Self {
        Self {
            tool: tool.to_owned(),
            state: GraphState::Indexed {
                project: project.to_owned(),
            },
        }
    }

    /// The project a review can ask for callers; `None` when it cannot ask.
    #[must_use]
    pub fn project(&self) -> Option<&str> {
        match &self.state {
            GraphState::Indexed { project } if !project.is_empty() => Some(project),
            GraphState::Indexed { .. }
            | GraphState::Unavailable { .. }
            | GraphState::Unindexed { .. } => None,
        }
    }

    /// Whether a review can ask it for callers.
    #[must_use]
    pub fn usable(&self) -> bool {
        self.project().is_some()
    }

    /// Whether it did not answer at all.
    #[must_use]
    pub fn unavailable(&self) -> bool {
        matches!(self.state, GraphState::Unavailable { .. })
    }
}
