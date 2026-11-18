//! The consumers list (realm @nick/craft, node #529): `craft review start` prepares, before it
//! hands out lenses, the lines of the head checkout that name each symbol the diff changes or
//! adds outside the changed lines — callers, implementors, places passing it as a value — with
//! file and line, within a per-symbol and a per-run budget. It unions the code graph's callers,
//! when the reviewer's profile says the graph answers and its index is not older than the base,
//! with a name search, always run, because the graph loses edges. Each lens gets the list and
//! marks every line; the report says which sources built it. Rust symbols only.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::project::{self, CodeGraph};

pub mod cbm;
mod fresh;
mod list;
mod names;
mod symbols;
#[cfg(test)]
mod tests;
mod text;

pub use text::{lens_block, section};

/// The name search's name in the report and on a site.
pub const NAME_SEARCH: &str = "name search";
/// The code graph's.
pub const GRAPH: &str = "codebase-memory";
/// The run directory's file holding the whole list.
pub const FILE: &str = "consumers.json";

/// One line that names a changed symbol.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Site {
    pub file: String,
    pub line: u32,
    pub text: String,
    /// The sources that found it.
    pub from: Vec<String>,
}

/// A changed symbol and the lines that name it, as many as the budgets keep.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Listed {
    pub name: String,
    pub file: String,
    pub line: u32,
    pub sites: Vec<Site>,
}

/// What a run's list came to. Every field optional, so a state written before it reads as a run
/// that built none.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Consumers {
    /// The sources that built the list.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<String>,
    /// Why the code graph was not one of them.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub graph_skipped: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub symbols: Vec<Listed>,
    /// The changed symbols not searched by name: too common a name, or the search failed, each with
    /// why when it is not the name alone.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unsearched: Vec<String>,
    /// How many lines the budgets left out.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub cut: usize,
    /// Where the whole list is written.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub file: String,
}

#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "serde passes a reference"
)]
fn is_zero(n: &usize) -> bool {
    *n == 0
}

impl Consumers {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    /// How many lines the list holds.
    #[must_use]
    pub fn lines(&self) -> usize {
        self.symbols.iter().map(|s| s.sites.len()).sum()
    }
}

/// The code graph the profile of the repository at `cwd` under `projects` names as usable;
/// why not otherwise.
///
/// # Errors
/// Why the graph is not to be asked, a line for the report.
pub fn graph_of(projects: Option<&Path>, cwd: &Path) -> Result<CodeGraph, String> {
    let projects = projects.ok_or("no review profile directory")?;
    let (path, _) = project::profile_path(projects, cwd).map_err(|e| e.to_string())?;
    let profile = project::load(&path).map_err(|e| e.to_string())?;
    let graph = profile
        .and_then(|p| p.code_graph)
        .ok_or("the review profile names no code graph (`craft init --write` checks for one)")?;
    if graph.usable() {
        return Ok(graph);
    }
    Err(if graph.note.is_empty() {
        format!("{} did not answer when `craft init` checked", graph.tool)
    } else {
        format!("`craft init` found {} unusable: {}", graph.tool, graph.note)
    })
}

/// The list for the change of the working tree at `top` against `diff`'s base (read from its
/// merge-base, as the lenses' diff), over its changed files, the graph asked when `graph` names
/// one.
#[must_use]
pub fn build(top: &Path, diff: &crate::git::Diff, graph: Result<CodeGraph, String>) -> Consumers {
    let text = crate::git::zero_context_diff(top, &diff.base).unwrap_or_default();
    let changed = crate::gate::lines::Lines::parse(&text);
    let found = symbols::changed(top, &diff.files, &changed, list::SYMBOLS_MAX);
    let (callers, graph_skipped) = match graph {
        Ok(g) => list::graph_callers(top, &diff.merge_base, &g, &found),
        Err(why) => (None, why),
    };
    let mut out = list::assemble(top, &changed, &found, callers.as_deref());
    out.graph_skipped = graph_skipped;
    out
}

/// Writes `c` as `dir`/[`FILE`], noting the path in it.
///
/// # Errors
/// When the file cannot be written.
pub fn write(dir: &Path, c: &mut Consumers) -> std::io::Result<()> {
    let path = dir.join(FILE);
    c.file = path.display().to_string();
    let body = serde_json::to_string_pretty(c).map_err(std::io::Error::other)?;
    std::fs::write(&path, body)
}
