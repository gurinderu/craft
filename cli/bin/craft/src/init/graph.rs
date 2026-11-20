//! What `craft init` says and records of the code graph (realm @nick/craft, node #529): what it
//! says now, against what the profile holds.

use craft_review::project::{CodeGraph, GraphState};

/// The code graph a write records, and its line: what the graph says now, unless it did not
/// answer while the profile holds a usable one, which is kept (realm @nick/craft, node #529).
/// When the held profile cannot be read (`held` is why), a usable graph found now is recorded;
/// otherwise none is, so the write leaves the section it holds as it stands, and says so.
pub(super) fn recorded(
    (live, says): (CodeGraph, String),
    held: Result<Option<CodeGraph>, String>,
) -> (Option<CodeGraph>, String) {
    match held {
        Ok(Some(h)) if live.unavailable() && h.usable() => {
            let says = format!(
                "{says}; the profile keeps the code graph it held, {}",
                described(Some(&h))
            );
            (Some(h), says)
        }
        Err(why) if !live.usable() => (
            None,
            format!(
                "{says}; the profile held could not be read ({why}), so its code graph section \
                 is left as it stands"
            ),
        ),
        Ok(_) | Err(_) => (Some(live), says),
    }
}

/// What the code graph says now, a line labelled as live, and where it differs from what the
/// profile holds (`held`), that too: a review reads the profile, not this.
pub(super) fn live_says((live, says): (CodeGraph, String), held: Option<&CodeGraph>) -> String {
    if held == Some(&live) {
        return format!("now: {says}");
    }
    format!(
        "now: {says}; the profile holds {}, which a review reads until a write records this",
        described(held)
    )
}

/// A held code graph in words.
fn described(g: Option<&CodeGraph>) -> String {
    match g.map(|g| &g.state) {
        None => "no code graph".into(),
        Some(GraphState::Indexed { project }) => format!("project {project}"),
        Some(GraphState::Unindexed { .. }) => "a graph indexing no project of it".into(),
        Some(GraphState::Unavailable { .. }) => "a graph that did not answer".into(),
        Some(GraphState::Unreadable { .. }) => "a code graph section it cannot read".into(),
    }
}
