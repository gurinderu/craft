//! The code graph's part of the list: its callers of the changed symbols, asked only of an index
//! of this repository made of a commit holding the review's base, and each caller's lines in head
//! that name the symbol.

use std::path::Path;
use std::time::{Duration, Instant};

use super::cbm::{Asked, Cbm};
use super::fresh;
use super::symbols::Symbol;
use crate::cancel::Cancel;
use crate::project::{self, CodeGraph, GraphState};

mod error;
mod owner;
mod sites;
mod target;

pub use target::own as craft_project;

/// The part of the graph's budget kept for reading its index again once its callers are asked.
const RECHECK: Duration = Duration::from_secs(5);

pub use error::GraphError;
pub(super) use sites::graph_sites;

/// The graph's callers of `found`, asked until `cancel` is, once the graph has indexed `top` under
/// craft's own project (realm @nick/craft, node #529) within the graph's budget, its index lock
/// under `locks`; why the graph was not asked otherwise: the lock held past the budget, the index
/// not done in time (left running), not ready, naming no root, of another checkout than `top`,
/// made of a commit not holding `merge_base`, or no answer; or why its answers were dropped: the
/// index moved while they were asked (node #533).
///
/// # Errors
/// Why the graph's callers are not in the list.
pub(super) fn graph_callers(
    top: &Path,
    merge_base: &str,
    (g, locks): (&CodeGraph, &Path),
    found: &[Symbol],
    cancel: &Cancel,
) -> Result<Asked, GraphError> {
    let cbm = Cbm::new(&g.tool).stopped_by(cancel).locked_in(locks);
    let deadline = Instant::now() + cbm.budget;
    let project = target::own(top)?;
    let checkout = top.display().to_string();
    cbm.reindex(&checkout, &project, deadline)
        .map_err(|why| GraphError::Reindex {
            checkout: checkout.clone(),
            why,
        })?;
    let index = cbm.index(&project, deadline)?;
    target::of_this_checkout(&project, &index, top)?;
    fresh::stale(merge_base, &project, &index)?;
    let (left_out, asked): (Vec<&Symbol>, Vec<&Symbol>) =
        found.iter().partition(|s| index.leaves_out(&s.file));
    let symbols: Vec<(&str, &str)> = asked
        .iter()
        .map(|s| (s.name.as_str(), s.file.as_str()))
        .collect();
    // The callers stop short of the deadline, so the index can still be read once after them.
    let asked_until = deadline.checked_sub(RECHECK).unwrap_or(deadline);
    let mut out = cbm.callers(&project, &symbols, asked_until)?;
    // Another run may index the same project while this one asks it: the graph swaps its new
    // index in whole, so answers from before and after the swap would mix (node #533).
    let after = cbm.index(&project, deadline)?;
    if (&after.at, &after.root) != (&index.at, &index.root) {
        return Err(GraphError::Moved { project });
    }
    let not_indexed = left_out
        .iter()
        .map(|s| format!("{} (file not indexed by the graph)", s.name));
    out.unasked.extend(not_indexed);
    if index.unindexed_cut {
        out.unasked.extend(unanswered(&asked, &out));
    }
    Ok(out)
}

/// The symbols of `asked` the graph named no caller of, each said as one whose file may not be
/// indexed: the graph's list of the files it left out was cut.
fn unanswered(asked: &[&Symbol], out: &Asked) -> Vec<String> {
    let called = |s: &Symbol| {
        out.callers
            .iter()
            .any(|c| c.symbol == s.name && c.defined_in == s.file)
    };
    asked
        .iter()
        .filter(|s| !called(s))
        .map(|s| {
            format!(
                "{} (no callers, and the graph's list of the files it left out was cut: its file \
                 may not be indexed)",
                s.name
            )
        })
        .collect()
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
