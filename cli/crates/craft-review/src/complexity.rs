//! A metrics-or-nothing lens, as the JS adversarial-review engine ran its complexity lens before it was
//! retired (realm @nick/craft, nodes #421, #445): the binary's own index of the graph beside the
//! consumers list (node #529) says whether a code-metrics index covers the checkout, and without
//! one the plan drops the lens, saying why; each of its findings
//! carries the numbers it rests on, read from the graph — the engine sets no cutoff, and neither does
//! this —, and one carrying none is dropped; its verifier re-reads
//! the metrics rather than judging by argument.

use serde_json::Value;

use crate::content::{self, ContentError};
use crate::profile::Profile;
use crate::prompts::{self, PromptContext};

mod metrics;

pub use metrics::{findings_schema, sift, values};

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
/// graph beside the consumers list (no agent indexes or warms it: node #529), and the note when
/// they may not; `None` when no profile taking part has one (`wanted` false).
#[must_use]
pub fn indexed(ctx: &PromptContext, wanted: bool) -> Option<(bool, Option<String>)> {
    if !wanted {
        return None;
    }
    if !ctx.graph_project.is_empty() && ctx.consumers.graph_indexed {
        return Some((true, None));
    }
    let why = if ctx.graph_project.is_empty() {
        "craft's graph project for this repository could not be named"
    } else if !ctx.consumers.graph_skipped.is_empty() {
        ctx.consumers.graph_skipped.as_str()
    } else if !ctx.consumers.failed.is_empty() {
        ctx.consumers.failed.as_str()
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

/// The prompt of a metrics lens, `brief` over the diff from `base` in the graph's `project`
/// ([`project`]) as the engine renders it, then what its findings must carry here.
///
/// # Errors
/// When a content file is missing.
pub fn lens_body(brief: &str, base: &str, project: &str) -> Result<String, ContentError> {
    let vars = content::vars([("base", base.to_owned()), ("project", project.to_owned())]);
    let body = content::prompt(brief, &vars)?;
    Ok(format!("{body}\n\n{}", content::text("lens-metrics")?))
}

#[cfg(test)]
#[path = "complexity_tests.rs"]
mod tests;
