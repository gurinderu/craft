//! The answer's `## Findings` list, one line per reported finding: severity, `file:line`, title and
//! tier, as `findingsList` in integrations/shared/cli-review-findings.mjs writes it. The unverified Low
//! and Info findings the binary held apart are left out, one sentence naming how many and the file
//! they are in (realm @nick/craft, node #636); the finished step keeps them all.

use serde_json::Value;

use super::report::{one_line, text};

/// The list over the finished `step`.
pub(super) fn list(step: &Value) -> String {
    let held = held_apart(step);
    let rows: Vec<String> = step
        .get("findings")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter(|f| held.is_none() || !is_held(f))
        .map(row)
        .collect();
    let mut body = rows.join("\n");
    if let Some((count, file)) = held {
        if !body.is_empty() {
            body.push('\n');
        }
        body.push_str(&format!(
            "{count} Low or Info finding(s) no verifier checked are not listed: they are in {file}."
        ));
    }
    if body.is_empty() {
        body.push_str("None reported.");
    }
    format!("## Findings\n\n{body}")
}

/// How many findings the binary held apart and where, when it held any.
fn held_apart(step: &Value) -> Option<(u64, String)> {
    let h = step.get("unverifiedLow")?;
    let count = h.get("count").and_then(Value::as_u64).filter(|n| *n > 0)?;
    let file = one_line(text(h, "file"));
    (!file.is_empty()).then_some((count, file))
}

/// Whether `f` is one the binary holds apart: unverified, at Low or Info severity.
fn is_held(f: &Value) -> bool {
    text(f, "tier") == "unverified" && matches!(text(f, "severity"), "Low" | "Info")
}

fn row(f: &Value) -> String {
    let severity = match one_line(text(f, "severity")) {
        s if s.is_empty() => "unrated".to_owned(),
        s => s,
    };
    let at = match f.get("line").and_then(Value::as_u64) {
        Some(n) if n > 0 => format!(":{n}"),
        _ => String::new(),
    };
    let tier = match one_line(text(f, "tier")) {
        t if t.is_empty() => String::new(),
        t => format!(" ({t})"),
    };
    let (file, title) = (one_line(text(f, "file")), one_line(text(f, "title")));
    format!("- [{severity}] {file}{at} — {title}{tier}")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::list;

    fn step(held: Option<serde_json::Value>) -> serde_json::Value {
        let mut s = json!({"findings": [
            {"severity": "High", "file": "a.rs", "line": 1, "title": "bug", "tier": "confirmed"},
            {"severity": "Medium", "file": "a.rs", "line": 2, "title": "dead check", "tier": "unverified"},
            {"severity": "Low", "file": "b.rs", "line": 3, "title": "naming", "tier": "unverified"},
            {"severity": "Info", "file": "b.rs", "line": 4, "title": "nit", "tier": "unverified"},
            {"severity": "Low", "file": "c.rs", "line": 5, "title": "checked", "tier": "confirmed"},
        ]});
        if let Some(h) = held {
            s["unverifiedLow"] = h;
        }
        s
    }

    #[test]
    fn the_held_findings_leave_the_list_and_one_line_names_their_count_and_file() {
        let got = list(&step(Some(json!({"count": 2, "file": "/r/unverified.md"}))));
        assert_eq!(
            got,
            "## Findings\n\n- [High] a.rs:1 — bug (confirmed)\n- [Medium] a.rs:2 — dead check (unverified)\n- [Low] c.rs:5 — checked (confirmed)\n2 Low or Info finding(s) no verifier checked are not listed: they are in /r/unverified.md."
        );
    }

    #[test]
    fn a_step_naming_none_held_lists_every_finding() {
        for held in [None, Some(json!({"count": 0, "file": "/r/u.md"}))] {
            let got = list(&step(held));
            assert!(
                got.contains("— naming (unverified)") && got.contains("— nit (unverified)"),
                "{got}"
            );
            assert!(!got.contains("not listed"), "{got}");
        }
    }

    #[test]
    fn only_held_findings_leave_no_none_reported_line() {
        let s = json!({"findings": [{"severity": "Low", "file": "b.rs", "title": "n", "tier": "unverified"}],
            "unverifiedLow": {"count": 1, "file": "/r/u.md"}});
        assert_eq!(
            list(&s),
            "## Findings\n\n1 Low or Info finding(s) no verifier checked are not listed: they are in /r/u.md."
        );
        assert_eq!(list(&json!({})), "## Findings\n\nNone reported.");
    }
}
