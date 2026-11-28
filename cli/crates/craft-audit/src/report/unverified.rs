//! The run's `unverified.md`: the Low and Info findings no verifier checked, held apart.

use serde_json::Value;

use super::Summary;
use super::entry::entry;

/// The unverified Low and Info findings held apart, Low first, as `unverified.md` lists them;
/// `None` when there are none.
#[must_use]
pub fn list(sum: &Summary) -> Option<String> {
    let mut held = sum.held();
    if held.is_empty() {
        return None;
    }
    held.sort_by_key(|f| f.get("severity").and_then(Value::as_str) != Some("Low"));
    let mut out = String::from(
        "# Unverified Low and Info findings\n\nNo verifier checked these against the code.\n\n",
    );
    out.extend(held.into_iter().map(entry));
    Some(out)
}
