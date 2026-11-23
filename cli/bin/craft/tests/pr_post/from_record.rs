//! `craft review post` reading its run record: the PR the review published on, lines not judged,
//! and the defect chosen.

use serde_json::{Value, json};

use super::support::{Posting, text};

fn sent(f: &Posting) -> Value {
    serde_json::from_str(&std::fs::read_to_string(f.bin.join("sent.json")).unwrap()).unwrap()
}

fn record(f: &Posting) -> Value {
    serde_json::from_str(&std::fs::read_to_string(&f.record).unwrap()).unwrap()
}

#[test]
fn the_records_pr_and_unjudged_lines_reach_the_post() {
    let f = Posting::with(&json!({"prComments": {"pr": 5}, "sorting": {"inDiffJudged": false}}));
    let other = f.post(&["--n", "1", "--as", "question", "--pr", "6"]);
    assert_eq!(other.status.code(), Some(2), "{}", text(&other.stderr));
    assert!(
        text(&other.stderr).contains("PR #6 is not PR #5, the one the review published on"),
        "{}",
        text(&other.stderr)
    );
    let out = f.post(&["--n", "1", "--as", "question"]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    let said: Value = serde_json::from_str(&text(&out.stdout)).unwrap();
    assert_eq!((&said["pr"], &said["toFile"]), (&json!(5), &json!(true)));
    let sent = sent(&f);
    assert_eq!(
        (&sent["subject_type"], sent.get("line")),
        (&json!("file"), None),
        "lines not judged: on its file"
    );
    let calls = std::fs::read_to_string(f.bin.join("calls")).unwrap();
    assert!(calls.contains("pr view 5 --json"), "{calls}");
    assert!(!calls.contains("pr list"), "{calls}");
}

#[test]
fn a_defect_is_posted_without_the_ask_and_recorded_as_a_defect() {
    let f = Posting::new();
    let out = f.post(&["--n", "1", "--as", "defect"]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    let body = sent(&f)["body"].as_str().unwrap().to_owned();
    assert!(
        body.ends_with("<!-- craft-lens: intent -->\n<!-- craft-finding -->"),
        "{body}"
    );
    assert!(!body.contains("Question to the author"), "{body}");
    assert_eq!(
        record(&f)["sorting"]["choices"]["1"]["choice"],
        json!("defect")
    );
}

#[test]
fn a_closed_pr_without_pr_is_refused_and_a_failed_list_is_a_failure_to_retry() {
    let f = Posting::with(&json!({"prComments": {"pr": 5}}));
    let merged = r#"{"number":5,"url":"u","headRefOid":"0","headRefName":"feat/x","isCrossRepository":false,"state":"MERGED"}"#;
    std::fs::write(f.bin.join("view"), merged).unwrap();
    let closed = f.post(&["--n", "1", "--as", "question"]);
    assert_eq!(closed.status.code(), Some(2), "{}", text(&closed.stderr));
    assert!(
        text(&closed.stderr)
            .contains("PR #5 is not open: the PR is closed or gone: name it with --pr <n>"),
        "{}",
        text(&closed.stderr)
    );
    let g = Posting::new();
    std::fs::write(g.bin.join("fail-list"), "").unwrap();
    let failed = g.post(&["--n", "1", "--as", "question"]);
    assert_eq!(failed.status.code(), Some(1), "{}", text(&failed.stderr));
    let err = text(&failed.stderr);
    assert!(
        err.contains("gh pr list failed") && err.contains("a retry names it with --record"),
        "{err}"
    );
    assert!(!f.bin.join("sent.json").exists() && !g.bin.join("sent.json").exists());
}
