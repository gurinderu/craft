//! A gate signal asked for and not established — the gate's own build was impossible, or a tool
//! was missing — and what CI said of it: a green CI check never stands for it (realm @nick/craft,
//! node #487), so a review over it gives at most Warning and its verdict line says why.

use super::{Gate, Status};

/// The profiles whose gate stayed unknown, in the tracks' order.
pub(crate) fn profiles(gate: &Gate) -> Vec<&str> {
    gate.tracks
        .iter()
        .filter(|t| t.status == Status::Unknown)
        .map(|t| t.profile.as_str())
        .collect()
}

/// Why an unknown gate holds the verdict, with what CI said of it; `None` when none is unknown.
#[must_use]
pub fn reason(gate: &Gate) -> Option<String> {
    let profiles = profiles(gate);
    if profiles.is_empty() {
        return None;
    }
    let named: Vec<String> = profiles.iter().map(|p| format!("{p}: unknown")).collect();
    let ci: Vec<&str> = gate
        .tracks
        .iter()
        .filter(|t| t.status == Status::Unknown)
        .flat_map(|t| {
            t.provenance
                .split(" · ")
                .chain(t.notes.iter().map(String::as_str))
        })
        .filter(|p| p.starts_with("CI for ") || p.starts_with("CI gave no "))
        .collect();
    let seen = if ci.is_empty() {
        "no CI check informed it".to_owned()
    } else {
        ci.join("; ")
    };
    Some(format!(
        "the gate was not established locally ({}); {seen}",
        named.join(", ")
    ))
}
