//! What `craft init` asks the code graph and says of it (realm @nick/craft, node #529).

use std::path::Path;

use super::Cbm;

use crate::project::{CodeGraph, GraphState};

/// How a graph newly indexing this repository is recorded so a review asks it: a write keeps
/// only the points and CI entries it is given.
pub const RECORD: &str = "record it with `craft init --write` and every point and CI entry to keep \
                          (`craft init --propose` lists them)";

/// What `craft init` finds for the repository whose roots (its top level, and its main checkout
/// for a linked worktree) are `roots`: whether `tool` answers and which project indexes it.
#[must_use]
pub fn probe(tool: &str, roots: &[String]) -> CodeGraph {
    let cbm = Cbm::new(tool);
    let state = match cbm.project_of(roots) {
        Err(why) => GraphState::Unavailable {
            note: why.to_string(),
        },
        Ok(None) => GraphState::Unindexed {
            note: format!("no project indexes {}", roots.join(" or ")),
        },
        Ok(Some(project)) => GraphState::Indexed { project },
    };
    CodeGraph {
        tool: tool.to_owned(),
        state,
    }
}

/// What `tool` says now of the repository at `cwd`, from one look: the graph and its line for
/// the reviewer.
#[must_use]
pub fn look(tool: &str, cwd: &Path) -> (CodeGraph, String) {
    let roots = roots_of(cwd);
    let graph = probe(tool, &roots);
    let says = said(&graph);
    (graph, says)
}

/// The roots the graph may know the repository at `cwd` by: its top level and, for a linked
/// worktree, the main checkout beside the shared git directory.
#[must_use]
pub fn roots_of(cwd: &Path) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(top) = crate::git::toplevel(cwd) {
        out.push(top.display().to_string());
    }
    let main = crate::git::common_dir(cwd).ok().and_then(|c| {
        let p = Path::new(&c);
        (p.file_name()? == ".git").then(|| p.parent().map(|d| d.display().to_string()))?
    });
    out.extend(main.filter(|m| !out.contains(m)));
    out
}

/// What `craft init` says of `g`, a line for the reviewer: a review indexes the checkout it reads
/// itself, so a graph that indexes no project of the repository yet is asked too.
#[must_use]
pub fn said(g: &CodeGraph) -> String {
    match &g.state {
        GraphState::Indexed { project } => format!(
            "{} answers and indexes this repository as {project}: a review adds its callers to \
             the consumers list",
            g.tool
        ),
        GraphState::Unindexed { note } => format!(
            "{} answers and indexes no project of this repository yet ({note}): a review indexes \
             the checkout it reads itself and adds its callers to the consumers list",
            g.tool
        ),
        GraphState::Unavailable { note } => format!(
            "{} is not available ({note}): the consumers list is built from name search alone",
            g.tool
        ),
        GraphState::Unreadable { note } => format!(
            "{} cannot be read from the profile ({note}): the consumers list is built from name \
             search alone",
            g.tool
        ),
    }
}
