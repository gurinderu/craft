//! A metrics-or-nothing lens, as the JS adversarial-review engine ran its complexity lens before it was
//! retired (realm @nick/craft, nodes #421, #445): the binary's own index of the graph beside the
//! consumers list (node #529) says whether a code-metrics index covers the checkout, and the binary
//! reads from it the numbers of every function the change touches; without them the plan drops the
//! lens, saying why. The lens and its verifier judge from those numbers in their prompt, so they
//! need none of the graph's MCP tools, which a task agent may not have. Each of its findings
//! carries the numbers it rests on — the engine sets no cutoff, and neither does this —, and one
//! carrying none is dropped; its verifier checks them against the review's rows rather than
//! judging by argument.

use serde_json::Value;

use crate::content::{self, ContentError};
use crate::profile::Profile;
use crate::prompts::{self, PromptContext};

mod metrics;
mod table;

pub(crate) use metrics::{COUNTS, FLAGS};
pub use metrics::{findings_schema, sift, values};
pub use table::{lens_table, rows_of};

/// Whether `profile` has a lens that needs the index.
#[must_use]
pub fn wanted(profile: &Profile) -> bool {
    profile.lenses.iter().any(|l| l.metrics)
}

/// The graph's project the consumers list, the metrics lenses and their verifier name for the
/// repository at `repo`: craft's own (realm @nick/craft, node #529); `None` when the repository's
/// shared git directory cannot be read.
#[must_use]
pub fn project(repo: &str) -> Option<String> {
    crate::consumers::craft_project(std::path::Path::new(repo)).ok()
}

/// Whether the metrics-or-nothing lenses may run, from what the binary found when it indexed the
/// graph beside the consumers list and read the numbers of the functions the change touches (no
/// agent indexes, warms or asks it: node #529 — the lenses judge from the numbers in their prompt),
/// and the note when they may not; `None` when no profile taking part has one (`wanted` false).
#[must_use]
pub fn indexed(ctx: &PromptContext, wanted: bool) -> Option<(bool, Option<String>)> {
    if !wanted {
        return None;
    }
    let c = &ctx.consumers;
    let ready = !ctx.graph_project.is_empty() && c.graph_indexed && c.metrics_failed.is_empty();
    if ready && !c.metrics.is_empty() {
        return Some((true, None));
    }
    if ready {
        return Some((
            false,
            Some(
                "the complexity lens did not run: no function the change touches carries the code \
                 graph's numbers -> the metrics-or-nothing lenses had nothing to judge"
                    .into(),
            ),
        ));
    }
    let why = if ctx.graph_project.is_empty() {
        "craft's graph project for this repository could not be named"
    } else if !c.metrics_failed.is_empty() {
        c.metrics_failed.as_str()
    } else if !c.graph_skipped.is_empty() {
        c.graph_skipped.as_str()
    } else if !c.failed.is_empty() {
        c.failed.as_str()
    } else {
        "it was not indexed"
    };
    Some((
        false,
        Some(format!(
            "the complexity lens did not run: the codebase-memory index is unavailable ({}) -> the \
             metrics-or-nothing lenses dropped",
            prompts::sanitize(why)
        )),
    ))
}

/// Whether `f` is a metrics lens's finding: it carries the numbers it rests on.
#[must_use]
pub fn is_metric(f: &Value) -> bool {
    f.get("metrics").is_some_and(Value::is_object)
}

/// The prompt of a metrics lens, `brief` rendered with `vars` (the diff's base, range and
/// pathspec, and the [`lens_table`] of its part), then what its findings must carry here.
///
/// # Errors
/// When a content file is missing.
pub fn lens_body(brief: &str, vars: &content::Vars) -> Result<String, ContentError> {
    let body = content::prompt(brief, vars)?;
    Ok(format!("{body}\n\n{}", content::text("lens-metrics")?))
}

#[cfg(test)]
#[path = "complexity_tests.rs"]
pub(crate) mod tests;
