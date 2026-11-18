//! The list built: the change's symbols read from its zero-context diff, their consumers found,
//! or why no list could be built.

use std::path::Path;

use super::{Consumers, changed, graph, graph_of, list};
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
/// profiles in `projects` say it answers; a list that says why it was not built when the
/// checkout's top cannot be read.
#[must_use]
pub fn of_checkout(cwd: &Path, projects: Option<&Path>, diff: &crate::git::Diff) -> Consumers {
    match crate::git::toplevel(cwd) {
        Ok(top) => build(&top, diff, graph_of(projects, &top)),
        Err(e) => Consumers::failed(format!("the checkout's top could not be read: {e}")),
    }
}

/// The list for the change of the working tree at `top` against `diff`'s merge-base (as the
/// lenses' diff), over its changed files, the graph asked when `graph` names one; a list that
/// says why it was not built when the change's diff cannot be read.
#[must_use]
pub fn build(top: &Path, diff: &crate::git::Diff, graph: Result<CodeGraph, String>) -> Consumers {
    let text = match crate::git::zero_context_diff(top, &diff.merge_base) {
        Ok(text) => text,
        Err(e) => return Consumers::failed(format!("the change's diff could not be read: {e}")),
    };
    let changed = crate::gate::lines::Lines::parse(&text);
    let removed = crate::gate::lines::removals(&text);
    let found = changed::changed(top, &diff.files, &changed, &removed, list::SYMBOLS_MAX);
    let (asked, graph_skipped) = match graph {
        Ok(g) => graph::graph_callers(top, &diff.merge_base, &g, &found.symbols),
        Err(why) => (None, why),
    };
    let callers = asked.as_ref().map(|a| a.callers.as_slice());
    let mut out = list::assemble(top, &changed, &found.symbols, callers);
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
