//! The list built: the change's symbols read from its zero-context diff, their consumers found,
//! or why no list could be built.

use std::path::Path;

use super::graph::{self, GraphError, graph_found};
use super::{Consumers, changed, list};
use crate::cancel::Cancel;
use crate::project::CodeGraph;

impl Consumers {
    /// A list that was not built, saying why.
    #[must_use]
    pub fn failed(why: impl Into<String>) -> Self {
        Self {
            failed: why.into(),
            ..Self::default()
        }
    }
}

/// The list for the change of the checkout `cwd` is in, the code graph asked when the reviewer's
/// profiles in `projects` say it answers, its name search and the graph's questions run until
/// `cancel` is; a list that says why it was not built when the checkout's top cannot be read.
#[must_use]
pub fn of_checkout(
    cwd: &Path,
    (projects, probe, metrics): (Option<&Path>, &str, bool),
    diff: &crate::git::Diff,
    cancel: &Cancel,
) -> Consumers {
    // Beside the profiles, `~/.craft/cbm-locks` for a review's `~/.craft/projects`.
    let locks = projects
        .and_then(Path::parent)
        .map_or_else(crate::consumers::cbm::scratch_locks, |h| {
            h.join("cbm-locks")
        });
    match crate::git::toplevel(cwd) {
        Ok(top) => {
            let graph = (graph_found(projects, &top, probe), locks.as_path(), metrics);
            build_until(&top, diff, graph, cancel)
        }
        Err(e) => Consumers::failed(format!("the checkout's top could not be read: {e}")),
    }
}

/// The list for the change of the working tree at `top` against `diff`'s merge-base (as the
/// lenses' diff), over its changed files, the graph asked when `graph` names one; a list that
/// says why it was not built when the change's diff cannot be read.
#[must_use]
pub fn build(
    top: &Path,
    diff: &crate::git::Diff,
    graph: Result<CodeGraph, GraphError>,
) -> Consumers {
    let locks = crate::consumers::cbm::scratch_locks();
    build_until(top, diff, (graph, &locks, false), &Cancel::default())
}

/// [`build`], the graph indexed for the metrics lenses too, though the change has no symbol.
#[must_use]
pub fn build_for_metrics(
    top: &Path,
    diff: &crate::git::Diff,
    graph: Result<CodeGraph, GraphError>,
) -> Consumers {
    let locks = crate::consumers::cbm::scratch_locks();
    build_until(top, diff, (graph, &locks, true), &Cancel::default())
}

/// [`build`], its name search and the graph's questions run until `cancel` is.
fn build_until(
    top: &Path,
    diff: &crate::git::Diff,
    (graph, locks, metrics): (Result<CodeGraph, GraphError>, &Path, bool),
    cancel: &Cancel,
) -> Consumers {
    let text = match crate::git::zero_context_diff(top, &diff.merge_base) {
        Ok(text) => text,
        Err(e) => return Consumers::failed(format!("the change's diff could not be read: {e}")),
    };
    let changed = crate::gate::lines::Lines::parse(&text);
    let removed = crate::gate::lines::removals(&text);
    let found = changed::changed(top, &diff.files, &changed, &removed, list::SYMBOLS_MAX);
    // Nothing to ask of it, and no metrics lens to read it: the graph is not indexed either.
    let graph = graph.and_then(|g| {
        if found.symbols.is_empty() && !metrics {
            Err(GraphError::NothingToAsk)
        } else {
            Ok(g)
        }
    });
    let ready = graph.and_then(|g| graph::ready(top, &diff.merge_base, (&g, locks), cancel));
    let mut indexed = ready.is_ok();
    // The metrics lenses' numbers, read before the callers: their gate is these, not the list.
    let read = match (&ready, metrics) {
        (Ok(r), true) => Some(graph::graph_metrics(r, &changed)),
        _ => None,
    };
    // Indexed for the metrics lenses alone, the graph is asked nothing and is no source.
    let asked = ready.and_then(|r| {
        (!found.symbols.is_empty())
            .then(|| graph::graph_callers(&r, &found.symbols))
            .transpose()
    });
    let (asked, graph_skipped) = match asked {
        Ok(a) => (a, String::new()),
        Err(why) => {
            // An index that moved meanwhile may be another checkout's now.
            indexed &= !matches!(why, GraphError::Moved { .. });
            (None, why.to_string())
        }
    };
    let callers = asked.as_ref().map(|a| a.callers.as_slice());
    let mut out = list::assemble(top, &changed, &found.symbols, cancel, callers);
    if let Some(a) = asked {
        out.graph_truncated = a.truncated;
        out.graph_unasked = a.unasked;
    }
    out.graph_skipped = graph_skipped;
    match read {
        Some(Ok(r)) => (out.metrics, out.metrics_unread) = (r.measured, r.unread),
        Some(Err(why)) => {
            indexed &= !matches!(why, GraphError::Moved { .. });
            out.metrics_failed = why.to_string();
        }
        None => {}
    }
    out.graph_indexed = indexed;
    out.unplaced = found.unplaced;
    out.unlisted = found.unlisted;
    out.unreadable = found.unreadable;
    out
}
