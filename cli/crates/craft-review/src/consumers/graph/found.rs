//! Which code graph a review asks (realm @nick/craft, node #529): the one the reviewer's profile
//! records, or, when it records none, one answering where the review looks for it.

use std::path::Path;

use super::GraphError;
use crate::project::{self, CodeGraph, GraphState};

/// The code graph of the repository at `cwd`: the one its profile under `projects` records, else,
/// when the profile records none, `probe` (`codebase-memory-mcp`, found on PATH) once it answers
/// (realm @nick/craft, node #529); an empty `probe` is never asked.
///
/// # Errors
/// Why the graph is not to be asked.
pub fn graph_found(
    projects: Option<&Path>,
    cwd: &Path,
    probe: &str,
) -> Result<CodeGraph, GraphError> {
    match graph_of(projects, cwd) {
        Err(GraphError::NotRecorded) if !probe.is_empty() => {
            match crate::consumers::cbm::answers(probe) {
                Ok(()) => Ok(CodeGraph {
                    tool: probe.to_owned(),
                    state: GraphState::Unindexed {
                        note: "no profile records it; it answered when the review asked".into(),
                    },
                }),
                Err(why) => Err(GraphError::NotFound {
                    tool: probe.to_owned(),
                    why,
                }),
            }
        }
        other => other,
    }
}

/// The code graph the profile of the repository at `cwd` under `projects` names as answering —
/// whatever project it records, it only says the graph is there: a review indexes and asks
/// craft's own (realm @nick/craft, node #529).
///
/// # Errors
/// Why the graph is not to be asked.
pub fn graph_of(projects: Option<&Path>, cwd: &Path) -> Result<CodeGraph, GraphError> {
    let projects = projects.ok_or(GraphError::NoProfiles)?;
    let (path, _) =
        project::profile_path(projects, cwd).map_err(|e| GraphError::Profile(e.to_string()))?;
    let profile = project::load(&path).map_err(|e| GraphError::Profile(e.to_string()))?;
    let graph = profile
        .and_then(|p| p.code_graph)
        .ok_or(GraphError::NotRecorded)?;
    let note = match &graph.state {
        GraphState::Indexed { .. } | GraphState::Unindexed { .. } => return Ok(graph),
        GraphState::Unavailable { note } if note.is_empty() => {
            "it did not answer when `craft init` checked".to_owned()
        }
        GraphState::Unavailable { note } | GraphState::Unreadable { note } => note.clone(),
    };
    Err(GraphError::Unusable {
        tool: graph.tool,
        note,
    })
}
