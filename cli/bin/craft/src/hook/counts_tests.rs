use serde_json::{Value, json};

use super::counts;
use crate::hook::record::{Detail, Line};
use crate::hook::repo::{Git, Here};

pub struct Fake;

impl Git for Fake {
    fn merge_base(&self, base: &str) -> Option<String> {
        match base {
            "origin/main" | "abc123" => Some("POINT".into()),
            "HEAD~1" => Some("PARENT".into()),
            "feat/base" => Some("FORK".into()),
            _ => None,
        }
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
        ("base", json!("HEAD~1")),
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
fn an_unreadable_detail_file_never_counts() {
    let (l, _) = review();
    let line: Line = serde_json::from_value(l).unwrap();
    assert!(!counts(&line, None, &here(), &Fake));
}
