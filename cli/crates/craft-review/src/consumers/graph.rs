//! The code graph's part of the list: its callers of the changed symbols, asked only of an
//! index not older than the review's base, and each caller's lines in head that name the symbol.

use std::collections::HashMap;
use std::path::Path;

use super::cbm::{Asked, Caller, Cbm};
use super::list::{consumer, site};
use super::symbols::Symbol;
use super::{GRAPH, Site, fresh, names};
use crate::gate::lines::Lines;
use crate::project::{self, CodeGraph};

/// The graph's callers of `found`, or why the graph was not asked: its index not ready or older
/// than `merge_base`, or no answer.
pub(super) fn graph_callers(
    top: &Path,
    merge_base: &str,
    g: &CodeGraph,
    found: &[Symbol],
) -> (Option<Asked>, String) {
    let cbm = Cbm::new(&g.tool);
    let asked = cbm.index(&g.project).and_then(|index| {
        if let Some(why) = fresh::stale(top, merge_base, &g.project, &index) {
            return Err(why);
        }
        let symbols: Vec<(&str, &str)> = found
            .iter()
            .map(|s| (s.name.as_str(), s.file.as_str()))
            .collect();
        cbm.callers(&g.project, &symbols)
    });
    match asked {
        Ok(c) => (Some(c), String::new()),
        Err(why) => (None, why),
    }
}

/// The lines of a caller's span in head that name `sym`, and whether any line there names it at
/// all: the graph's index may be of another checkout, so a span naming it nowhere is not listed.
pub(super) fn graph_sites(
    files: &mut HashMap<String, Vec<String>>,
    top: &Path,
    c: &Caller,
    sym: &Symbol,
    changed: &Lines,
) -> (Vec<Site>, bool) {
    let lines = files.entry(c.file.clone()).or_insert_with(|| {
        let text = std::fs::read_to_string(top.join(&c.file)).unwrap_or_default();
        text.lines().map(str::to_owned).collect()
    });
    let naming: Vec<(u32, &str)> = (c.start..=c.end)
        .filter_map(|n| {
            let t = lines.get(usize::try_from(n).ok()?.checked_sub(1)?)?;
            names::names(t, &sym.name).then_some((n, t.as_str()))
        })
        .collect();
    let out = naming
        .iter()
        .filter_map(|&(n, t)| {
            Some(site(
                &c.file,
                n,
                t,
                GRAPH,
                consumer(changed, sym, &c.file, n, t)?,
            ))
        })
        .collect();
    (out, !naming.is_empty())
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
