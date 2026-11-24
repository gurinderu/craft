use serde_json::{Value, json};

use super::counts;
use crate::hook::record::{Detail, Line};
use crate::hook::repo::{Git, Here};

pub struct Fake;

impl Git for Fake {
    /// A local `main` that lags `origin/main`, and relative bases that happen to meet the head
    /// where the PR's base does (a one-commit branch): only the rule, not git, keeps them out.
    fn merge_base(&self, base: &str) -> Option<String> {
        match base {
            "origin/main" | "abc123" | "HEAD" | "ORIG_HEAD" | "HEAD~1" | "HEAD^" | "@" | "@~1"
            | "main~0" => Some("POINT".into()),
            "main" => Some("LAGGED".into()),
            "feat/base" => Some("FORK".into()),
            _ => None,
        }
    }

    fn has_ref(&self, name: &str) -> bool {
        name == "origin/main"
    }
}

pub fn here() -> Here {
    Here {
        project: "/p".into(),
        head: "H".into(),
        branch: "feat/x".into(),
        trunk: "origin/main".into(),
        point: "POINT".into(),
    }
}

/// A finished full CLI review of the whole change: its index line and its detail file.
fn review() -> (Value, Value) {
    (
        json!({"kind": "workflow", "name": "review", "head": "H", "verdict": "Approve",
            "dirty": false, "nested": false}),
        json!({"lensScope": "full", "depth": "full", "path": "", "base": "origin/main",
            "notRun": [], "lensRounds": [{"round": 1}]}),
    )
}

fn judge(line: &Value, detail: &Value) -> bool {
    let line: Line = serde_json::from_value(line.clone()).unwrap();
    let detail: Detail = serde_json::from_value(detail.clone()).unwrap();
    counts(&line, Some(&detail), &here(), &Fake)
}

#[test]
fn a_finished_full_review_of_the_whole_change_on_the_head_counts() {
    let (l, d) = review();
    assert!(judge(&l, &d));
    for (field, v) in [
        ("base", json!("abc123")),
        ("base", json!("main")),
        ("path", json!(".")),
        ("path", Value::Null),
        ("depth", Value::Null),
    ] {
        let mut d = d.clone();
        d[field] = v;
        assert!(judge(&l, &d), "{field}");
    }
    let mut l = l;
    l["name"] = json!("cli-review");
    assert!(judge(&l, &d));
}

#[test]
fn every_narrowing_of_a_review_takes_it_out() {
    let (line, detail) = review();
    let on_line: &[(&str, Value)] = &[
        ("verdict", json!("Approve (PARTIAL COVERAGE)")),
        ("verdict", json!("Block (partial coverage)")),
        ("verdict", json!("Warning (INCOMPLETE)")),
        ("verdict", json!("INCOMPLETE (empty diff)")),
        ("verdict", json!("  ")),
        ("verdict", Value::Null),
        ("dirty", json!(true)),
        ("nested", json!(true)),
        ("kind", json!("agent")),
        ("name", json!("rust-audit")),
        ("name", json!("triage-findings")),
        ("head", json!("OTHER")),
    ];
    for (field, v) in on_line {
        let mut l = line.clone();
        l[*field] = v.clone();
        assert!(!judge(&l, &detail), "{field}: {v}");
    }
    let in_detail: &[(&str, Value)] = &[
        ("partial", json!(true)),
        ("lensScope", json!("delta")),
        ("depth", json!("light")),
        ("path", json!("cli")),
        ("notRun", json!(["lens x died"])),
        ("notRun", Value::Null),
        ("lensRounds", json!([])),
        ("lensRounds", Value::Null),
        ("base", json!("HEAD")),
        ("base", json!("ORIG_HEAD")),
        ("base", json!("HEAD~1")),
        ("base", json!("HEAD^")),
        ("base", json!("@")),
        ("base", json!("@~1")),
        ("base", json!("main~0")),
        ("base", json!("feat/base")),
        ("base", json!("gone")),
        ("base", json!("")),
    ];
    for (field, v) in in_detail {
        let mut d = detail.clone();
        d[*field] = v.clone();
        assert!(!judge(&line, &d), "{field}: {v}");
    }
}

#[test]
fn a_warning_held_by_a_coverage_gap_alone_counts_as_a_full_review() {
    // A metrics-only lens that never returned is a coverage gap, filed apart from `notRun`: the run
    // is a full review, and asking for another would hit the same gap.
    let (mut l, mut d) = review();
    l["verdict"] = json!("Warning");
    d["capped"] = json!(["general metrics-only lenses that never returned — complexity: died"]);
    assert!(judge(&l, &d));
}

#[test]
fn an_unreadable_detail_file_never_counts() {
    let (l, _) = review();
    let line: Line = serde_json::from_value(l).unwrap();
    assert!(!counts(&line, None, &here(), &Fake));
}

#[test]
fn a_full_review_with_nothing_to_review_counts_and_a_red_gate_does_not() {
    let (mut l, mut d) = review();
    l["verdict"] = json!("Approve (nothing to review)");
    d["lensRounds"] = json!([]);
    assert!(judge(&l, &d));
    let narrowed: &[(&str, Value)] = &[
        ("notRun", json!(["x"])),
        ("lensRounds", Value::Null),
        ("lensScope", json!("delta")),
    ];
    for (field, v) in narrowed {
        let mut d = d.clone();
        d[*field] = v.clone();
        assert!(!judge(&l, &d), "{field}: {v}");
    }
    for verdict in [
        "Block",
        "Approve",
        "Warning",
        "Warning (nothing to review) (PARTIAL COVERAGE)",
        "Approve (nothing to review) (PARTIAL COVERAGE)",
        "Approve (nothing to review) — a prose note",
        "approve (NOTHING TO REVIEW)",
    ] {
        l["verdict"] = json!(verdict);
        assert!(!judge(&l, &d), "{verdict}");
    }
}

#[test]
fn nothing_to_review_held_at_warning_by_an_unread_runbook_still_counts() {
    // The gap holds the verdict at Warning; it does not take the run out of review.
    let (mut l, mut d) = review();
    l["verdict"] = json!("Warning (nothing to review)");
    d["lensRounds"] = json!([]);
    d["capped"] = json!(["runbook signal could not read a changed Markdown file — ops.md"]);
    assert!(judge(&l, &d));
}

#[test]
fn a_verdict_of_javascripts_whitespace_alone_is_no_verdict() {
    assert!(!super::clean(Some("\u{feff} \u{2028}")));
    assert!(super::clean(Some("\u{85}")));
}
