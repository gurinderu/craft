//! The code graph's part of the list: its callers of the changed symbols, asked only of an index
//! of this repository made of a commit holding the review's base, and each caller's lines in head
//! that name the symbol.

use std::collections::HashMap;
use std::path::Path;

use super::cbm::{self, Asked, Caller, Cbm, CbmError};
use super::fresh::{self, Stale};
use super::list::{consumer, site};
use super::symbols::Symbol;
use super::{GRAPH, Site, names, source};
use crate::cancel::Cancel;
use crate::gate::lines::Lines;
use crate::project::{self, CodeGraph, GraphState};

/// Why the code graph was not asked, or gave no callers; its text is the report's line.
#[derive(Debug, thiserror::Error)]
pub enum GraphError {
    #[error("no review profile directory")]
    NoProfiles,
    #[error("the review profile could not be read: {0}")]
    Profile(String),
    #[error(
        "the review profile names no code graph (`craft init --propose` checks for one and \
         prints the write that records it)"
    )]
    NotRecorded,
    #[error(
        "`craft init` found {tool} unusable: {note}; once it answers and indexes this repository, {}",
        cbm::RECORD
    )]
    Unusable { tool: String, note: String },
    #[error("{0}")]
    Cbm(#[from] CbmError),
    #[error("the index of {project} names no root it indexes, so whose it is cannot be told")]
    NoRoot { project: String },
    #[error("the index of {project} is of {root}, not of this repository ({roots})")]
    Foreign {
        project: String,
        root: String,
        roots: String,
    },
    #[error("{0}")]
    Stale(#[from] Box<Stale>),
}

/// The graph's callers of `found`, asked until `cancel` is; why the graph was not asked
/// otherwise: its index not ready, naming no root, of another repository than `top`'s, made of a
/// commit not holding `merge_base`, or no answer.
///
/// # Errors
/// Why the graph's callers are not in the list.
pub(super) fn graph_callers(
    top: &Path,
    merge_base: &str,
    g: &CodeGraph,
    found: &[Symbol],
    cancel: &Cancel,
) -> Result<Asked, GraphError> {
    let project = g.project().ok_or_else(|| GraphError::Unusable {
        tool: g.tool.clone(),
        note: "it names no project".into(),
    })?;
    let cbm = Cbm::new(&g.tool).stopped_by(cancel);
    let index = cbm.index(project)?;
    let roots = cbm::roots_of(top);
    if index.root.is_empty() {
        return Err(GraphError::NoRoot {
            project: project.to_owned(),
        });
    }
    if !roots.contains(&index.root) {
        return Err(GraphError::Foreign {
            project: project.to_owned(),
            root: index.root,
            roots: roots.join(" or "),
        });
    }
    fresh::stale(merge_base, project, &index)?;
    let (left_out, asked): (Vec<&Symbol>, Vec<&Symbol>) =
        found.iter().partition(|s| index.leaves_out(&s.file));
    let symbols: Vec<(&str, &str)> = asked
        .iter()
        .map(|s| (s.name.as_str(), s.file.as_str()))
        .collect();
    let mut out = cbm.callers(project, &symbols)?;
    let not_indexed = left_out
        .iter()
        .map(|s| format!("{} (file not indexed by the graph)", s.name));
    out.unasked.extend(not_indexed);
    Ok(out)
}

/// The lines of `file` in head, read once per file as [`source::read_within`] reads it; an
/// absent file has none. Why not, `file (why)`.
fn head_lines<'a>(
    files: &'a mut HashMap<String, Result<Vec<String>, String>>,
    top: &Path,
    file: &str,
) -> Result<&'a Vec<String>, String> {
    let read =
        files
            .entry(file.to_owned())
            .or_insert_with(|| match source::read_within(top, file) {
                Ok(text) => Ok(text
                    .unwrap_or_default()
                    .lines()
                    .map(str::to_owned)
                    .collect()),
                Err(e) => Err(format!("{file} ({e})")),
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

/// The code graph the profile of the repository at `cwd` under `projects` names as usable.
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
        GraphState::Indexed { .. } if graph.usable() => return Ok(graph),
        GraphState::Indexed { .. } => "it names no project".to_owned(),
        GraphState::Unavailable { note } if note.is_empty() => {
            "it did not answer when `craft init` checked".to_owned()
        }
        GraphState::Unavailable { note }
        | GraphState::Unindexed { note }
        | GraphState::Unreadable { note } => note.clone(),
    };
    Err(GraphError::Unusable {
        tool: graph.tool,
        note,
    })
}
