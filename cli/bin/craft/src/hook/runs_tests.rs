use std::fmt::Write as _;

use serde_json::{Value, json};

use super::{Found, Scope, look};
use crate::hook::counts::tests::Fake;
use crate::hook::repo::Here;

const HEAD: &str = "1111111111111111111111111111111111111111";
const OTHER: &str = "2222222222222222222222222222222222222222";

fn here() -> Here {
    Here {
        project: "/p".into(),
        head: HEAD.into(),
        branch: "feat/x".into(),
        trunk: "origin/main".into(),
        point: "POINT".into(),
    }
}

const GIT: Fake = Fake;

/// A finished full review as the store files it: index fields and detail fields in one object.
fn run(ts: &str, head: &str, verdict: &str, scope: &str) -> Value {
    json!({"ts": ts, "kind": "workflow", "name": "review", "project": "/p", "branch": "feat/x",
        "head": head, "verdict": verdict, "nested": false, "dirty": false, "lensScope": scope,
        "depth": "full", "path": "", "base": "origin/main", "notRun": [], "lensRounds": [{}]})
}

/// A store holding `runs` (their detail files too) and the extra raw index `lines`.
fn store(runs: &[Value], lines: &[&str]) -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let mut index = String::new();
    for r in runs {
        writeln!(index, "{r}").unwrap();
        let file = format!(
            "{}-workflow-{}.json",
            r["ts"].as_str().unwrap(),
            r["name"].as_str().unwrap()
        );
        std::fs::write(d.path().join(file), r.to_string()).unwrap();
    }
    for l in lines {
        writeln!(index, "{l}").unwrap();
    }
    std::fs::write(d.path().join("index.jsonl"), index).unwrap();
    d
}

fn missing(found: Found) -> (Option<super::LastRun>, usize) {
    match found {
        Found::Missing { last, malformed } => (last, malformed),
        other @ (Found::Reviewed | Found::NoStore(_)) => {
            panic!("expected a warning, got {other:?}")
        }
    }
}

#[test]
fn a_full_finished_run_on_the_head_is_silent() {
    let s = store(&[run("2026-11-01T10-00-00Z", HEAD, "Block", "full")], &[]);
    assert!(matches!(look(s.path(), &here(), &GIT), Found::Reviewed));
}

#[test]
fn only_a_delta_run_on_the_head_warns_naming_it() {
    let s = store(
        &[run("2026-11-01T10-00-00Z", HEAD, "Warning", "delta")],
        &[],
    );
    let (last, _) = missing(look(s.path(), &here(), &GIT));
    let last = last.unwrap();
    assert_eq!((last.head.as_str(), last.scope), (HEAD, Scope::Delta));
}

#[test]
fn a_nested_run_does_not_count_and_another_project_s_is_not_the_last() {
    let mut nested = run("2026-11-01T10-00-00Z", HEAD, "Approve", "full");
    nested["nested"] = json!(true);
    nested["via"] = json!("rust-audit");
    let mut elsewhere = run("2026-11-01T12-00-00Z", HEAD, "Approve", "full");
    elsewhere["project"] = json!("/q");
    let s = store(&[nested], &[]);
    missing(look(s.path(), &here(), &GIT));
    elsewhere["head"] = json!(OTHER);
    let s = store(&[elsewhere], &[]);
    assert!(missing(look(s.path(), &here(), &GIT)).0.is_none());
}

#[test]
fn the_branch_s_newest_run_is_named_whatever_the_order_filed() {
    let mut foreign = run("2026-11-03T10-00-00Z", OTHER, "Approve", "full");
    foreign["branch"] = json!("feat/other");
    let s = store(
        &[
            run("2026-11-02T10-00-00Z", OTHER, "Block", "delta"),
            run("2026-11-01T10-00-00Z", OTHER, "Approve", "full"),
            foreign,
        ],
        &[],
    );
    let (last, _) = missing(look(s.path(), &here(), &GIT));
    let last = last.unwrap();
    assert_eq!(
        (last.verdict.as_str(), last.scope, last.ts.as_str()),
        ("Block", Scope::Delta, "2026-11-02T10-00-00Z")
    );
}

#[test]
fn malformed_and_blank_index_lines_are_counted_and_passed_over() {
    let s = store(
        &[run("2026-11-01T10-00-00Z", HEAD, "Approve", "full")],
        &["{not json", "", "   ", "[1,2]", "\u{0}"],
    );
    assert!(matches!(look(s.path(), &here(), &GIT), Found::Reviewed));
    let s = store(&[], &["{not json", "", "  {", "42"]);
    let (last, malformed) = missing(look(s.path(), &here(), &GIT));
    assert!(last.is_none());
    assert_eq!(malformed, 3);
}

#[test]
fn an_unreadable_detail_file_leaves_the_scope_unknown_and_never_counts() {
    let s = store(&[run("2026-11-01T10-00-00Z", HEAD, "Approve", "full")], &[]);
    std::fs::remove_file(s.path().join("2026-11-01T10-00-00Z-workflow-review.json")).unwrap();
    let (last, _) = missing(look(s.path(), &here(), &GIT));
    assert_eq!(last.unwrap().scope, Scope::Unknown);
}

#[test]
fn a_store_with_no_index_yet_holds_no_review() {
    let d = tempfile::tempdir().unwrap();
    for at in [d.path().join("nope"), d.path().to_path_buf()] {
        let (last, malformed) = missing(look(&at, &here(), &GIT));
        assert!(last.is_none() && malformed == 0);
    }
}

#[test]
fn an_index_that_cannot_be_read_is_no_store() {
    let d = tempfile::tempdir().unwrap();
    std::fs::create_dir(d.path().join("index.jsonl")).unwrap();
    assert!(matches!(look(d.path(), &here(), &GIT), Found::NoStore(_)));
}

#[test]
fn thousands_of_lines_are_read_in_bounded_time() {
    let line = json!({"ts": "2026-11-01T10-00-00Z", "kind": "workflow", "name": "triage-findings",
        "project": "/p", "branch": "feat/x", "head": HEAD, "verdict": ""})
    .to_string();
    let lines: Vec<&str> = std::iter::repeat_n(line.as_str(), 20_000).collect();
    let s = store(&[], &lines);
    let began = std::time::Instant::now();
    missing(look(s.path(), &here(), &GIT));
    // Measured at about 0.1 s in a debug build; ten times that and more is a generous bound.
    assert!(
        began.elapsed() < std::time::Duration::from_secs(5),
        "{:?}",
        began.elapsed()
    );
}
