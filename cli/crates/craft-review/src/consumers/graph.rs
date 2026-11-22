//! The code graph's part of the list: its callers of the changed symbols, asked only of an index
//! of this repository made of a commit holding the review's base, and each caller's lines in head
//! that name the symbol.

use std::path::Path;
use std::time::{Duration, Instant};

use super::cbm::{Asked, Cbm};
use super::fresh;
use super::symbols::Symbol;
use crate::cancel::Cancel;
use crate::project::CodeGraph;

#[cfg(test)]
mod budget_tests;
mod error;
mod found;
mod metrics;
mod owner;
mod sites;
mod target;

pub use target::own as craft_project;

/// The part of the graph's budget kept for reading its index again once its callers are asked.
const RECHECK: Duration = Duration::from_secs(5);

pub use error::GraphError;
pub use found::{graph_found, graph_of};
pub use metrics::Measured;
pub(super) use metrics::{METRICS_FLOOR, graph_metrics};
pub(super) use sites::graph_sites;

/// The graph brought to `top` and found ready to ask: its program, craft's own project, that
/// project's index and the deadline of the graph's budget.
pub(super) struct Ready {
    cbm: Cbm,
    project: String,
    index: super::cbm::Index,
    deadline: Instant,
}

/// The graph indexed at `top` under craft's own project (realm @nick/craft, node #529) within the
/// graph's budget, its index lock under `locks`, until `cancel` is; why it is not ready otherwise:
/// the lock held past the budget, the index not done in time (left running), not ready, naming
/// no root, of another checkout than `top`, or made of a commit not holding `merge_base`.
///
/// # Errors
/// Why the graph is not ready to ask.
pub(super) fn ready(
    top: &Path,
    merge_base: &str,
    (g, locks): (&CodeGraph, &Path),
    cancel: &Cancel,
) -> Result<Ready, GraphError> {
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
    Ok(Ready {
        cbm,
        project,
        index,
        deadline,
    })
}

/// The callers of `found` the ready graph names; why its answers are not used: no answer, or the
/// index moved while they were asked (node #533).
///
/// # Errors
/// Why the graph's callers are not in the list.
pub(super) fn graph_callers(
    r: &Ready,
    found: &[Symbol],
    reserve: Duration,
) -> Result<Asked, GraphError> {
    let (cbm, project, index) = (&r.cbm, &r.project, &r.index);
    let (left_out, asked): (Vec<&Symbol>, Vec<&Symbol>) =
        found.iter().partition(|s| index.leaves_out(&s.file));
    let symbols: Vec<(&str, &str)> = asked
        .iter()
        .map(|s| (s.name.as_str(), s.file.as_str()))
        .collect();
    // The callers stop short of the deadline less what is kept for the metrics read, so the index
    // can still be read once after them.
    let deadline = r.deadline.checked_sub(reserve).unwrap_or(r.deadline);
    let asked_until = deadline.checked_sub(RECHECK).unwrap_or(deadline);
    let mut out = cbm.callers(project, &symbols, asked_until)?;
    // Another run may index the same project while this one asks it: the graph swaps its new
    // index in whole, so answers from before and after the swap would mix (node #533).
    let after = cbm.index(project, deadline)?;
    if (&after.at, &after.root) != (&index.at, &index.root) {
        return Err(GraphError::Moved {
            project: project.clone(),
            during: "its callers were asked",
        });
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
