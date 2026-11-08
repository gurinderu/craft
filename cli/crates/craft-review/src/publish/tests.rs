use serde_json::{Value, json};

use super::section::posted_line;
use super::{PostSetup, Posted, deliver, finished, section, settle};
use crate::state::{RunState, STATE_VERSION};

/// A finished run over `/nonexistent` (git cannot read its lines) whose verification settled
/// `settled`, asked to publish or not.
fn run(settled: &Value, asked: bool) -> RunState {
    serde_json::from_value(json!({
        "version": STATE_VERSION,
        "context": {"repo": "/nonexistent", "base": "origin/main", "spec": "", "craftRoot": null, "craftVersion": null},
        "diff": {"base": "origin/main", "mergeBase": "abc", "head": "def", "dirty": false, "files": ["src/lib.rs"], "stat": "", "log": ""},
        "tracks": [], "light": false, "phase": "done", "tasks": [], "verdict": "Block",
        "rounds": {"round": 1, "pool": [], "yields": [], "expected": [], "returned": [], "failures": {}},
        "findings": [], "settled": settled, "notes": [], "notRun": [], "publish": {"asked": asked}
    }))
    .unwrap()
}

fn f(title: &str, tier: &str, extra: &Value) -> Value {
    let mut f = json!({"severity": "High", "title": title, "file": "src/lib.rs", "line": 3, "why": "w", "fix": "x", "source": "errors", "tier": tier});
    for (k, v) in extra.as_object().unwrap() {
        f[k] = v.clone();
    }
    f
}

fn against(id: &str) -> Value {
    json!({"memoryContradicts": {"id": id, "kind": "decision", "why": "kept on purpose"}})
}

fn settled() -> Value {
    json!([
        f("plain defect", "confirmed", &json!({})),
        f("asked about", "suspected", &json!({})),
        f("goes against D-1", "confirmed", &against("D-1")),
        f("may go against D-2", "suspected", &against("D-2")),
        f("never checked", "unverified", &json!({})),
        f("refuted", "refuted", &json!({})),
    ])
}

#[test]
fn the_payload_sorts_the_findings_and_counts_those_going_against_memory() {
    let mut r = run(&settled(), true);
    settle(&mut r);
    let [(_, sorting), (_, contradictions), (_, pr)] = finished(&r);
    assert_eq!(
        (
            &sorting["defect"],
            &sorting["doubtful"],
            &sorting["inDiffJudged"]
        ),
        (&json!(2), &json!(2), &json!(false))
    );
    assert!(
        sorting["inDiffNote"]
            .as_str()
            .unwrap()
            .starts_with("git could not list")
    );
    let titles: Vec<&Value> = sorting["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| &x["title"])
        .collect();
    assert_eq!(
        titles,
        [&json!("asked about"), &json!("may go against D-2")]
    );
    assert_eq!(sorting["findings"][1]["n"], json!(2));
    assert_eq!(pr, Value::Null, "nothing is posted before delivery");
    assert_eq!(
        (&contradictions["count"], &contradictions["inDiffJudged"]),
        (&json!(2), &json!(false))
    );
    let to_pr: Vec<&Value> = contradictions["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| &x["toPr"])
        .collect();
    assert_eq!(to_pr, [&json!(true), &json!(false)]);
    let defects = &r.publish.sorting.as_ref().unwrap().defects;
    assert!(
        defects.iter().all(|d| d.line.is_none()),
        "unjudged lines go to the file"
    );
    assert!(section(&r).contains("- 2 defect(s) to post; not posted yet"));
}

#[test]
fn an_unconfirmed_contradiction_is_doubtful_with_its_record_first() {
    let mut r = run(
        &json!([f("may go against D-2", "suspected", &against("D-2"))]),
        true,
    );
    settle(&mut r);
    let s = section(&r);
    assert!(
        s.contains("1. High · `src/lib.rs:3` · may go against D-2 · doubtful: goes against memory decision D-2: kept on purpose; not confirmed (suspected)"),
        "{s}"
    );
}

#[test]
fn a_review_of_uncommitted_work_posts_nothing_and_says_why() {
    let mut r = run(&settled(), true);
    r.diff.dirty = true;
    settle(&mut r);
    let dir = tempfile::tempdir().unwrap();
    let nowhere = PostSetup {
        path: Some(dir.path().as_os_str().to_owned()),
        ..PostSetup::default()
    };
    deliver(dir.path(), &mut r, &nowhere).unwrap();
    let p = r.publish.posted.as_ref().unwrap();
    assert_eq!(
        (p.requested, p.posted, p.error.as_str()),
        (2, 0, ""),
        "gh is never called"
    );
    assert!(p.reason.starts_with("the review read uncommitted changes"));
    let report = std::fs::read_to_string(dir.path().join("report.md")).unwrap();
    assert!(
        report
            .contains("- ⚠️ nothing was posted (2 defect(s)): the review read uncommitted changes")
    );
}

#[test]
fn unasked_nothing_is_sorted_or_posted_and_contradictions_are_still_counted() {
    let mut r = run(&settled(), false);
    settle(&mut r);
    let [(_, sorting), (_, contradictions), (_, pr)] = finished(&r);
    assert_eq!((sorting, pr), (Value::Null, Value::Null));
    assert_eq!(contradictions["count"], json!(2));
    let dir = tempfile::tempdir().unwrap();
    let nowhere = PostSetup {
        path: Some(dir.path().as_os_str().to_owned()),
        ..PostSetup::default()
    };
    deliver(dir.path(), &mut r, &nowhere).unwrap();
    assert!(r.publish.posted.is_none() && section(&r).is_empty());
}

#[test]
fn the_posting_line_says_what_landed_and_what_failed() {
    let p = |posted, already, failed, error: &str| Posted {
        pr: 7,
        requested: 3,
        posted,
        already,
        failed,
        reason: "PR #7 u".into(),
        error: error.into(),
        ..Posted::default()
    };
    assert_eq!(
        posted_line(&p(2, 1, 0, "")),
        "- posted 2 of 3 defect(s) · 1 already on the PR (craft-finding marker), not posted again · PR #7 u"
    );
    assert_eq!(
        posted_line(&p(1, 0, 2, "gh api failed: HTTP 422")),
        "- ⚠️ posted 1 of 3 defect(s) · 0 already on the PR (craft-finding marker), not posted again · PR #7 u · gh failed: gh api failed: HTTP 422"
    );
    let none = Posted {
        reason: "no defect to post".into(),
        no_file: 1,
        ..Posted::default()
    };
    assert_eq!(
        posted_line(&none),
        "- no defect to post · 1 defect(s) name no file and could not be posted"
    );
}
