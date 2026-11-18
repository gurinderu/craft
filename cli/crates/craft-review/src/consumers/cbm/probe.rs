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
    let says = said(&graph, &roots);
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

/// The command that indexes (or refreshes the index of) the repository at `root`, quoted for a
/// POSIX shell; craft never runs it.
#[must_use]
pub fn refresh_hint(root: &str) -> String {
    let args = serde_json::json!({"repo_path": root, "mode": "fast"});
    let quoted = args.to_string().replace('\'', r"'\''");
    format!("`{} cli index_repository '{quoted}'`", super::TOOL)
}

/// What `craft init` says of `g` for the repository whose roots are `roots`, a line for the
/// reviewer; a repository no project indexes is to be indexed at its main checkout, the last
/// root.
#[must_use]
pub fn said(g: &CodeGraph, roots: &[String]) -> String {
    match &g.state {
        GraphState::Indexed { project } => format!(
            "{} answers and indexes this repository as {project}: a review adds its callers to \
             the consumers list",
            g.tool
        ),
        GraphState::Unindexed { note } => format!(
            "{} answers but does not index this repository ({note}): the consumers list is built \
             from name search alone; index it with {}, then {}",
            g.tool,
            refresh_hint(roots.last().map_or("<repository root>", String::as_str)),
            RECORD
        ),
        GraphState::Unavailable { note } => format!(
            "{} is not available ({note}): the consumers list is built from name search alone",
            g.tool
        ),
    }
}
