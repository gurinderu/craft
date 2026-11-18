use std::fmt::Write as _;

use serde_json::{Value, json};

use super::{Found, Here, Scope, look};

const HEAD: &str = "1111111111111111111111111111111111111111";
const OTHER: &str = "2222222222222222222222222222222222222222";

fn here() -> Here {
    Here {
        project: "/p".into(),
        head: HEAD.into(),
        branch: Some("feat/x".into()),
    }
}

/// A run as the store files it: its index line, and its detail file carrying `lensScope`.
fn run(ts: &str, head: &str, verdict: &str, scope: Option<&str>) -> Value {
    let mut r = json!({"ts": ts, "kind": "workflow", "name": "review", "project": "/p",
        "branch": "feat/x", "head": head, "verdict": verdict, "nested": false});
    if let Some(s) = scope {
        r["lensScope"] = json!(s);
    }
    r
}

/// A store holding `runs` (their detail files too) and the extra raw index `lines`.
fn store(runs: &[Value], lines: &[&str]) -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let mut index = String::new();
    for r in runs {
        let mut line = r.clone();
        line.as_object_mut().unwrap().remove("lensScope");
        writeln!(index, "{line}").unwrap();
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
    let s = store(
        &[run("2026-11-01T10-00-00Z", HEAD, "Block", Some("full"))],
        &[],
    );
    assert!(matches!(look(s.path(), &here()), Found::Reviewed));
}

#[test]
fn a_run_filed_before_lens_scope_existed_counts_as_full() {
    let s = store(&[run("2026-11-01T10-00-00Z", HEAD, "Approve", None)], &[]);
    assert!(matches!(look(s.path(), &here()), Found::Reviewed));
}

#[test]
fn only_a_delta_run_on_the_head_warns() {
    let s = store(
        &[run("2026-11-01T10-00-00Z", HEAD, "Warning", Some("delta"))],
        &[],
    );
    let (last, _) = missing(look(s.path(), &here()));
    let last = last.unwrap();
    assert_eq!((last.head.as_str(), last.scope), (HEAD, Scope::Delta));
}

#[test]
fn an_incomplete_run_warns() {
    for v in [
        "INCOMPLETE",
        "Warning (INCOMPLETE)",
        "INCOMPLETE (argument refused)",
        "",
    ] {
        let s = store(&[run("2026-11-01T10-00-00Z", HEAD, v, Some("full"))], &[]);
        let (last, _) = missing(look(s.path(), &here()));
        assert_eq!(last.unwrap().verdict, v);
    }
}

#[test]
fn a_nested_or_partial_run_or_another_project_does_not_count() {
    let mut nested = run("2026-11-01T10-00-00Z", HEAD, "Approve", Some("full"));
    nested["nested"] = json!(true);
    let mut partial = run("2026-11-01T11-00-00Z", HEAD, "Approve", Some("full"));
    partial["partial"] = json!(true);
    let mut elsewhere = run("2026-11-01T12-00-00Z", HEAD, "Approve", Some("full"));
    elsewhere["project"] = json!("/q");
    let mut audit = run("2026-11-01T13-00-00Z", HEAD, "Approve", Some("full"));
    audit["name"] = json!("rust-audit");
    let s = store(&[nested, partial, elsewhere, audit], &[]);
    missing(look(s.path(), &here()));
}

#[test]
fn a_run_on_another_head_warns_naming_the_branch_s_last_run() {
    let s = store(
        &[
            run("2026-11-01T10-00-00Z", OTHER, "Approve", Some("full")),
            run("2026-11-02T10-00-00Z", OTHER, "Block", Some("delta")),
        ],
        &[],
    );
    let (last, _) = missing(look(s.path(), &here()));
    let last = last.unwrap();
    assert_eq!(
        (
            last.head.as_str(),
            last.verdict.as_str(),
            last.scope,
            last.ts.as_str()
        ),
        (OTHER, "Block", Scope::Delta, "2026-11-02T10-00-00Z")
    );
}

#[test]
fn the_cli_s_interim_name_counts_as_a_review() {
    let mut r = run("2026-11-01T10-00-00Z", HEAD, "Approve", Some("full"));
    r["name"] = json!("cli-review");
    let s = store(&[r], &[]);
    assert!(matches!(look(s.path(), &here()), Found::Reviewed));
}

#[test]
fn malformed_index_lines_are_counted_and_passed_over() {
    let s = store(
        &[run("2026-11-01T10-00-00Z", HEAD, "Approve", Some("full"))],
        &["{not json", "[1,2]", "\u{0}"],
    );
    assert!(matches!(look(s.path(), &here()), Found::Reviewed));
    let s = store(&[], &["{not json", "  {", "42"]);
    let (last, malformed) = missing(look(s.path(), &here()));
    assert!(last.is_none());
    assert_eq!(malformed, 3);
}

#[test]
fn an_unreadable_detail_file_leaves_the_scope_unknown() {
    let s = store(
        &[run("2026-11-01T10-00-00Z", HEAD, "Approve", Some("full"))],
        &[],
    );
    std::fs::remove_file(s.path().join("2026-11-01T10-00-00Z-workflow-review.json")).unwrap();
    let (last, _) = missing(look(s.path(), &here()));
    assert_eq!(last.unwrap().scope, Scope::Unknown);
}

#[test]
fn no_store_warns() {
    let d = tempfile::tempdir().unwrap();
    assert!(matches!(
        look(&d.path().join("nope"), &here()),
        Found::NoStore(_)
    ));
    assert!(matches!(look(d.path(), &here()), Found::NoStore(_)));
}

#[test]
fn thousands_of_lines_are_read_well_under_a_second() {
    let line = json!({"ts": "2026-11-01T10-00-00Z", "kind": "workflow", "name": "triage-findings",
        "project": "/p", "branch": "feat/x", "head": OTHER, "verdict": ""})
    .to_string();
    let lines: Vec<&str> = std::iter::repeat_n(line.as_str(), 20_000).collect();
    let s = store(&[], &lines);
    let began = std::time::Instant::now();
    missing(look(s.path(), &here()));
    assert!(
        began.elapsed() < std::time::Duration::from_millis(500),
        "{:?}",
        began.elapsed()
    );
}
