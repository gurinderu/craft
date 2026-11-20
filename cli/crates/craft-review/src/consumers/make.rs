//! The list built: the change's symbols read from its zero-context diff, their consumers found,
//! or why no list could be built.

use std::path::Path;

use super::graph::{self, GraphError, graph_of};
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
    projects: Option<&Path>,
    diff: &crate::git::Diff,
    cancel: &Cancel,
) -> Consumers {
    match crate::git::toplevel(cwd) {
        Ok(top) => build_until(&top, diff, graph_of(projects, &top), cancel),
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
    build_until(top, diff, graph, &Cancel::default())
}

/// [`build`], its name search and the graph's questions run until `cancel` is.
fn build_until(
    top: &Path,
    diff: &crate::git::Diff,
    graph: Result<CodeGraph, GraphError>,
    cancel: &Cancel,
) -> Consumers {
    let text = match crate::git::zero_context_diff(top, &diff.merge_base) {
        Ok(text) => text,
        Err(e) => return Consumers::failed(format!("the change's diff could not be read: {e}")),
    };
    let changed = crate::gate::lines::Lines::parse(&text);
    let removed = crate::gate::lines::removals(&text);
    let found = changed::changed(top, &diff.files, &changed, &removed, list::SYMBOLS_MAX);
    let asked =
        graph.and_then(|g| graph::graph_callers(top, &diff.merge_base, &g, &found.symbols, cancel));
    let (asked, graph_skipped) = match asked {
        Ok(a) => (Some(a), String::new()),
        Err(why) => (None, why.to_string()),
    };
    let callers = asked.as_ref().map(|a| a.callers.as_slice());
    let mut out = list::assemble(top, &changed, &found.symbols, cancel, callers);
    if let Some(a) = asked {
        out.graph_truncated = a.truncated;
        out.graph_unasked = a.unasked;
    }
    out.graph_skipped = graph_skipped;
    out.unplaced = found.unplaced;
    out.unlisted = found.unlisted;
    out.unreadable = found.unreadable;
    out
}
