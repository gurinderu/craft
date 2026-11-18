//! What `craft init` asks the code graph and says of it (realm @nick/craft, node #529).

use std::path::Path;

use super::Cbm;

use crate::project::CodeGraph;

/// What `craft init` finds for the repository whose roots (its top level, and its main checkout
/// for a linked worktree) are `roots`: whether `tool` answers and which project indexes it.
#[must_use]
pub fn probe(tool: &str, roots: &[String]) -> CodeGraph {
    let cbm = Cbm::new(tool);
    let (available, project, note) = match cbm.project_of(roots) {
        Err(why) => (false, String::new(), why.to_string()),
        Ok(None) => (
            true,
            String::new(),
            format!("no project indexes {}", roots.join(" or ")),
        ),
        Ok(Some(p)) => (true, p, String::new()),
    };
    CodeGraph {
        tool: tool.to_owned(),
        available,
        project,
        note,
    }
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

/// The command that indexes (or refreshes the index of) the repository at `root`; craft never
/// runs it.
#[must_use]
pub fn refresh_hint(root: &str) -> String {
    let args = serde_json::json!({"repo_path": root, "mode": "fast"});
    format!("`{} cli index_repository '{args}'`", super::TOOL)
}

/// What `craft init` says of `g` for the repository whose roots are `roots`, a line for the
/// reviewer.
#[must_use]
pub fn said(g: &CodeGraph, roots: &[String]) -> String {
    match (g.available, g.project.is_empty()) {
        (true, false) => format!(
            "{} answers and indexes this repository as {}: a review adds its callers to the consumers list",
            g.tool, g.project
        ),
        (true, true) => format!(
            "{} answers but does not index this repository ({}): the consumers list is built from name search alone; index it with {}",
            g.tool,
            g.note,
            refresh_hint(roots.first().map_or("<repository root>", String::as_str))
        ),
        (false, _) => format!(
            "{} is not available ({}): the consumers list is built from name search alone",
            g.tool, g.note
        ),
    }
}
