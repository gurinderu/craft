use serde_json::{Value, json};

use super::{Counts, counts};
use crate::hook::here::{Git, Here};
use crate::hook::record::{Detail, Line};

pub struct Fake {
    pub changed: Option<Vec<String>>,
}

impl Git for Fake {
    fn merge_base(&self, base: &str) -> Option<String> {
        match base {
            "origin/main" | "abc123" => Some("POINT".into()),
            "HEAD~1" => Some("PARENT".into()),
            "feat/base" => Some("FORK".into()),
            _ => None,
        }
    }

    fn changed(&self) -> Option<Vec<String>> {
        self.changed.clone()
    }
}

fn here() -> Here {
    Here {
        project: "/p".into(),
        head: "H".into(),
        branch: Some("feat/x".into()),
        named: None,
        trunk: "origin/main".into(),
        point: "POINT".into(),
    }
}

/// A finished full CLI review of the whole change: its index line and its detail file.
fn review() -> (Value, Value) {
    (
        json!({"kind": "workflow", "name": "review", "verdict": "Approve", "dirty": false}),
        json!({"lensScope": "full", "depth": "full", "path": "", "base": "origin/main",
            "notRun": [], "lensRounds": [{"round": 1}]}),
    )
}

/// A finished rust-audit of two crates whose change is all inside them.
fn audit() -> (Value, Value) {
    (
        json!({"kind": "workflow", "name": "rust-audit", "verdict": "Warning", "dirty": false}),
        json!({"scout": {"baseRef": "abc123"}, "gateBlocked": [], "reviews": [
            {"dimension": "review:a", "path": "cli/a", "verdict": "⚠️ Warning — 2 Medium"},
            {"dimension": "review:b", "path": "cli/b/", "verdict": "✅ Approve"}]}),
    )
}

fn judge(line: &Value, detail: &Value, changed: &[&str]) -> Counts {
    let line: Line = serde_json::from_value(line.clone()).unwrap();
    let detail: Detail = serde_json::from_value(detail.clone()).unwrap();
    let git = Fake {
        changed: Some(changed.iter().map(|s| (*s).to_owned()).collect()),
    };
    counts(&line, Some(&detail), &here(), &git)
}

const CRATES: &[&str] = &["cli/a/src/x.rs", "cli/b/Cargo.toml"];

#[test]
fn a_finished_full_review_of_the_whole_change_counts() {
    let (l, d) = review();
    assert_eq!(judge(&l, &d, &[]), Counts::Full);
    for (field, v) in [
        ("base", json!("abc123")),
        ("path", json!(".")),
        ("path", Value::Null),
    ] {
        let mut d = d.clone();
        d[field] = v;
        assert_eq!(judge(&l, &d, &[]), Counts::Full, "{field}");
    }
    let mut l = l;
    l["name"] = json!("cli-review");
    assert_eq!(judge(&l, &d, &[]), Counts::Full);
}

#[test]
fn every_narrowing_of_a_review_takes_it_out() {
    let (line, detail) = review();
    let on_line: &[(&str, Value)] = &[
        ("verdict", json!("Approve (PARTIAL COVERAGE)")),
        ("verdict", json!("Block (partial coverage)")),
        ("verdict", json!("Warning (INCOMPLETE)")),
        ("verdict", json!("INCOMPLETE (empty diff)")),
        ("verdict", json!("")),
        ("verdict", Value::Null),
        ("dirty", json!(true)),
        ("kind", json!("agent")),
        ("name", json!("triage-findings")),
    ];
    for (field, v) in on_line {
        let mut l = line.clone();
        l[*field] = v.clone();
        assert_eq!(judge(&l, &detail, &[]), Counts::No, "{field}: {v}");
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
        assert_eq!(judge(&line, &d, &[]), Counts::No, "{field}: {v}");
    }
}

#[test]
fn an_unreadable_detail_file_never_counts() {
    let (l, _) = review();
    let line: Line = serde_json::from_value(l).unwrap();
    let git = Fake { changed: None };
    assert_eq!(counts(&line, None, &here(), &git), Counts::No);
}

#[test]
fn a_rust_audit_whose_crate_reviews_finished_over_the_whole_change_counts() {
    let (l, d) = audit();
    assert_eq!(judge(&l, &d, CRATES), Counts::Full);
    let mut whole = d.clone();
    whole["reviews"] = json!([{"dimension": "review", "path": "", "verdict": "✅ Approve"}]);
    assert_eq!(
        judge(&l, &whole, &["lib/x.mjs"]),
        Counts::Full,
        "one unscoped review"
    );
    let mut no_base = d;
    no_base["scout"]["baseRef"] = json!("");
    assert_eq!(
        judge(&l, &no_base, CRATES),
        Counts::Full,
        "origin's default"
    );
}

#[test]
fn a_rust_audit_over_files_outside_its_crates_is_crates_only() {
    let (l, d) = audit();
    let mixed = ["cli/a/src/x.rs", "lib/pre-pr-hook.sh"];
    assert_eq!(judge(&l, &d, &mixed), Counts::CratesOnly);
    assert_eq!(
        judge(&l, &d, &["cli/ab/x.rs"]),
        Counts::CratesOnly,
        "a sibling prefix"
    );
    let line: Line = serde_json::from_value(l).unwrap();
    let detail: Detail = serde_json::from_value(d).unwrap();
    let blind = Fake { changed: None };
    assert_eq!(counts(&line, Some(&detail), &here(), &blind), Counts::No);
}

#[test]
fn every_unfinished_part_of_a_rust_audit_takes_it_out() {
    let (line, detail) = audit();
    for (field, v) in [
        ("verdict", json!("Warning (INCOMPLETE)")),
        ("verdict", json!("Approve (PARTIAL COVERAGE)")),
        ("dirty", json!(true)),
    ] {
        let mut l = line.clone();
        l[field] = v.clone();
        assert_eq!(judge(&l, &detail, CRATES), Counts::No, "{field}: {v}");
    }
    let nested_incomplete =
        json!([{"path": "cli/a", "verdict": "⚠️ Warning (INCOMPLETE) — a lens died"}]);
    let nested_partial = json!([{"path": "cli/a", "verdict": "Approve (PARTIAL COVERAGE)"}]);
    let never_answered = json!([{"path": "cli/a", "verdict": ""}]);
    for (field, v) in [
        ("reviews", nested_incomplete),
        ("reviews", nested_partial),
        ("reviews", never_answered),
        ("reviews", json!([])),
        ("reviews", Value::Null),
        ("gateBlocked", json!(["review:a"])),
        ("partial", json!(true)),
        ("scout", json!({"baseRef": "HEAD~1"})),
    ] {
        let mut d = detail.clone();
        d[field] = v.clone();
        assert_eq!(
            judge(&line, &d, &["cli/a/x.rs"]),
            Counts::No,
            "{field}: {v}"
        );
    }
}
