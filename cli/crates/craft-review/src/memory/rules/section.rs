//! The report section of what the project rules covered (`projectRuleSection` in
//! `lib/project-rule-apply.mjs`).

use serde_json::Value;

use super::super::judge::{WHY_MAX, clip, plain};

/// One covered finding as its section lists it.
fn line(f: &Value) -> String {
    // `f.line || 0`: a missing, null, zero or empty line reads 0.
    let at = match f.get("line") {
        Some(Value::Number(n)) if n.as_i64() != Some(0) => n.to_string(),
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        Some(Value::Bool(true)) => "true".to_owned(),
        _ => "0".to_owned(),
    };
    let file = plain(f.get("file"));
    let severity = plain(f.get("severity"));
    format!(
        "- {} · `{}:{at}` · {} · rule {} \"{}\" · {}",
        if f.get("severity").is_some_and(|v| !v.is_null()) {
            severity.as_str()
        } else {
            "?"
        },
        if file.is_empty() { "?" } else { &file },
        plain(f.get("title")),
        f.get("priorDecision")
            .map_or_else(|| "?".to_owned(), |v| plain(Some(v))),
        clip(&plain(f.get("ruleTitle")), WHY_MAX),
        plain(f.get("priorMatch")),
    )
}

/// The section listing the findings a rule covered and the `notices`; '' when there is neither.
#[must_use]
pub(in crate::memory) fn section(set_aside: &[Value], notices: &[String]) -> String {
    let own: Vec<String> = set_aside
        .iter()
        .filter(|f| f.get("priorKind").and_then(Value::as_str) == Some("rule"))
        .map(line)
        .chain(notices.iter().map(|n| format!("- ⚠️ {n}")))
        .collect();
    if own.is_empty() {
        return String::new();
    }
    format!(
        "\n\n## Covered by project rules (not in the verdict)\n{}",
        own.join("\n")
    )
}
