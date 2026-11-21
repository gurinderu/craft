//! The profile's `[code_graph]` section (realm @nick/craft, node #529): whether the code graph
//! answered when `craft init` asked, and which of its projects indexes this repository. A review
//! takes the graph's callers into its consumers list only when this says it can.
//!
//! Read leniently: the profile is shared by every craft binary on the machine, so a section of a
//! shape this one does not know (an earlier build's, a later state) reads as
//! [`GraphState::Unreadable`] — the graph not asked, the reason said — never as an unreadable
//! profile, which would drop its integration points and CI map too.

use serde::{Deserialize, Deserializer, Serialize};

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
    /// The profile's section is of a shape this binary does not read; why, a line.
    Unreadable { note: String },
}

/// The tool a section of an unknown shape names, when it names one as a string.
const UNNAMED: &str = "the code graph";

/// The `code_graph` section as [`CodeGraph`], or [`GraphState::Unreadable`] when it is of a shape
/// this binary does not know.
///
/// # Errors
/// Only when the document itself cannot be read; the section's own shape never fails it.
pub(super) fn lenient<'de, D: Deserializer<'de>>(d: D) -> Result<Option<CodeGraph>, D::Error> {
    let raw = toml::Value::deserialize(d)?;
    Ok(Some(raw.clone().try_into::<CodeGraph>().unwrap_or_else(|e| {
        let tool = raw.get("tool").and_then(toml::Value::as_str);
        CodeGraph {
            tool: tool.unwrap_or(UNNAMED).to_owned(),
            state: GraphState::Unreadable {
                note: format!(
                    "the profile's code_graph section is of a shape this craft does not read ({})",
                    e.message().trim()
                ),
            },
        }
    })))
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
            | GraphState::Unindexed { .. }
            | GraphState::Unreadable { .. } => None,
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
