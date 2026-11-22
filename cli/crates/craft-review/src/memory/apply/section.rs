//! The report sections of what the remembered records did (`priorRejectedSection` in
//! `integrations/shared/prior-decision-apply.mjs`, `priorDecisionsRefusedSection` in `integrations/shared/prior-decisions.mjs`): the
//! findings set aside, each with its mark and how it was matched, and what was not applied.

use serde_json::Value;

use super::or;

fn text<'a>(f: &'a Value, k: &str) -> &'a str {
    f.get(k).and_then(Value::as_str).unwrap_or("")
}

/// One set-aside finding as its section lists it.
fn section_line(f: &Value) -> String {
    let line = f.get("line").and_then(Value::as_i64).unwrap_or(0);
    let how = text(f, "priorMatch");
    let how = if how.is_empty() {
        String::new()
    } else {
        format!(" · {how}")
    };
    format!(
        "- {} · `{}:{line}` · {} · {}{how}",
        f.get("severity").and_then(Value::as_str).unwrap_or("?"),
        or(text(f, "file"), "?"),
        text(f, "title"),
        text(f, "why")
    )
}

/// The report sections listing the findings set aside (`priorRejectedSection`): a High a human's
/// decision set aside under its own (realm @nick/craft, node #196), every other decision's under
/// Rejected before, a deferral's under Known and deferred.
#[must_use]
pub(in crate::memory) fn section(set_aside: &[Value]) -> String {
    let high = |f: &&Value| text(f, "severity").trim().eq_ignore_ascii_case("high");
    let of = |kind: &str, want_high: bool| -> Vec<String> {
        set_aside
            .iter()
            .filter(|f| {
                text(f, "priorKind") == kind && (kind != "decision" || high(f) == want_high)
            })
            .map(section_line)
            .collect()
    };
    let (human, rejected, deferred) = (
        of("decision", true),
        of("decision", false),
        of("question", false),
    );
    let mut out = String::new();
    if !human.is_empty() {
        out.push_str(&format!(
            "\n\n## High rejected by a human (set aside — not in the verdict)\n{}",
            human.join("\n")
        ));
    }
    if !rejected.is_empty() {
        out.push_str(&format!(
            "\n\n## Rejected before (set aside — not in the verdict)\n{}",
            rejected.join("\n")
        ));
    }
    if !deferred.is_empty() {
        out.push_str(&format!(
            "\n\n## Known and deferred (open question — not in the verdict)\n{}",
            deferred.join("\n")
        ));
    }
    out
}

/// The section naming what of the records was not applied (`priorDecisionsRefusedSection`).
#[must_use]
pub(in crate::memory) fn refused_section(refused: &[String]) -> String {
    if refused.is_empty() {
        return String::new();
    }
    let lines: Vec<String> = refused.iter().map(|r| format!("- ⚠️ {r}")).collect();
    format!("\n\n## Prior decisions not applied\n{}\n", lines.join("\n"))
}
