//! The code graph's part of the list: its callers of the changed symbols, asked only of an
//! index not older than the review's base, and each caller's lines in head that name the symbol.

use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::{Component, Path};

use super::cbm::{self, Asked, Caller, Cbm};
use super::list::{consumer, site};
use super::symbols::Symbol;
use super::{GRAPH, Site, fresh, names};
use crate::gate::lines::Lines;
use crate::project::{self, CodeGraph};

/// The graph's callers of `found`; why the graph was not asked otherwise: its index not ready,
/// of another repository than `top`'s, or older than `merge_base`, or no answer.
pub(super) fn graph_callers(
    top: &Path,
    merge_base: &str,
    g: &CodeGraph,
    found: &[Symbol],
) -> Result<Asked, String> {
    let cbm = Cbm::new(&g.tool);
    let index = cbm.index(&g.project).map_err(|e| e.to_string())?;
    let roots = cbm::roots_of(top);
    if !index.root.is_empty() && !roots.contains(&index.root) {
        return Err(format!(
            "the index of {} is of {}, not of this repository ({})",
            g.project,
            index.root,
            roots.join(" or ")
        ));
    }
    if let Some(why) = fresh::stale(top, merge_base, &g.project, &index) {
        return Err(why);
    }
    let symbols: Vec<(&str, &str)> = found
        .iter()
        .map(|s| (s.name.as_str(), s.file.as_str()))
        .collect();
    cbm.callers(&g.project, &symbols).map_err(|e| e.to_string())
}

/// The lines of `file` in head, read once per file; an absent file has none. Why not, for a path
/// outside the repository or a file that cannot be read.
fn head_lines<'a>(
    files: &'a mut HashMap<String, Result<Vec<String>, String>>,
    top: &Path,
    file: &str,
) -> Result<&'a Vec<String>, String> {
    let read = files.entry(file.to_owned()).or_insert_with(|| {
        let path = Path::new(file);
        let outside = path.is_absolute()
            || path
                .components()
                .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)));
        if outside {
            return Err(format!("{file} (outside the repository)"));
        }
        match std::fs::read_to_string(top.join(file)) {
            Ok(text) => Ok(text.lines().map(str::to_owned).collect()),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(format!("{file} (unreadable: {e})")),
        }
    });
    read.as_ref().map_err(Clone::clone)
}

/// The lines of a caller's span in head that name `sym`, and whether any line there names it at
/// all: the graph's index may be of another checkout, so a span naming it nowhere is not listed.
/// Why not, for a caller whose file is outside the repository or cannot be read.
pub(super) fn graph_sites(
    files: &mut HashMap<String, Result<Vec<String>, String>>,
    top: &Path,
    c: &Caller,
    sym: &Symbol,
    changed: &Lines,
) -> Result<(Vec<Site>, bool), String> {
    let lines = head_lines(files, top, &c.file)?;
    let last = u32::try_from(lines.len()).unwrap_or(u32::MAX);
    let naming: Vec<(u32, &str)> = (c.start..=c.end.min(last))
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
    Ok((out, !naming.is_empty()))
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
