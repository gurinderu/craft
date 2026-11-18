//! The CONSUMERS lines a lens is shown and must mark: which of the run's list its prompt carries,
//! and the lines its answer leaves unmarked.

use serde_json::Value;

use crate::consumers::Consumers;

/// How many unmarked lines a refusal names before it counts the rest.
const SHOWN_MAX: usize = 10;

/// The lines of `c` (`file:line`) that `prompt` lists, in the list's order: each as the CONSUMERS
/// block renders it (`- file:line: text`, `consumers::text`), so a lens shown part of the list, or
/// none of it, is held to what it was shown.
#[must_use]
pub fn listed(prompt: &str, c: &Consumers) -> Vec<String> {
    c.sites()
        .into_iter()
        .filter(|site| prompt.contains(&format!("- {site}: ")))
        .collect()
}

/// The lines of `listed` that `answer`'s `consumers` does not mark, in `listed`'s order.
pub(super) fn unmarked(answer: &Value, listed: &[String]) -> Vec<String> {
    let marks: Vec<&str> = answer
        .get("consumers")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|m| m.get("site").and_then(Value::as_str))
        .collect();
    listed
        .iter()
        .filter(|s| !marks.contains(&s.as_str()))
        .cloned()
        .collect()
}

/// The refusal naming the lines `left` unmarked, as the retry prompt asks for them.
pub(super) fn refusal(left: &[String]) -> String {
    let more = left.len().saturating_sub(SHOWN_MAX);
    let more = if more == 0 {
        String::new()
    } else {
        format!(" and {more} more")
    };
    format!(
        "it leaves {} CONSUMERS line(s) unmarked ({}{more}): list each in `consumers` with the site as given and status \"checked\" or \"not-relevant\"",
        left.len(),
        left.iter()
            .take(SHOWN_MAX)
            .cloned()
            .collect::<Vec<_>>()
            .join(", ")
    )
}
