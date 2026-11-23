//! A retry of `craft review post` names the PR its first attempt chose: written into the
//! finding's choice before the post, read back with no `--pr`, whatever that PR's state now —
//! never another open PR of the branch.

use serde_json::{Value, json};

use super::support::{Posting, text};

fn choice(f: &Posting) -> Value {
    let r: Value = serde_json::from_str(&std::fs::read_to_string(&f.record).unwrap()).unwrap();
    r["sorting"]["choices"]["1"].clone()
}

/// PR 5 merged at the reviewed head, and a new open PR 9 of the same branch.
fn merged_with_a_new_pr(f: &Posting) {
    let pr = |n: u64, state: &str| {
        format!(
            r#"{{"number":{n},"url":"https://github.com/o/r/pull/{n}","headRefOid":"{}","headRefName":"feat/x","isCrossRepository":false,"state":"{state}"}}"#,
            f.head
        )
    };
    std::fs::write(f.bin.join("view"), pr(5, "MERGED")).unwrap();
    std::fs::write(f.bin.join("list"), format!("[{}]", pr(9, "OPEN"))).unwrap();
}

#[test]
fn a_failed_post_names_its_pr_and_its_retry_takes_that_pr_not_a_newer_one() {
    let f = Posting::new();
    std::fs::write(f.bin.join("fail-post"), "").unwrap();
    let failed = f.post(&["--n", "1", "--as", "question"]);
    assert_eq!(failed.status.code(), Some(1), "{}", text(&failed.stderr));
    assert!(
        text(&failed.stderr).contains("PR #5: "),
        "{}",
        text(&failed.stderr)
    );
    assert_eq!(
        (&choice(&f)["pr"], &choice(&f)["posting"]),
        (&json!(5), &json!(true))
    );
    std::fs::remove_file(f.bin.join("fail-post")).unwrap();
    merged_with_a_new_pr(&f);
    let retry = f.post(&["--n", "1", "--as", "question"]);
    assert_eq!(retry.status.code(), Some(2), "{}", text(&retry.stderr));
    assert!(
        text(&retry.stderr).contains("PR #5 is MERGED, not open")
            && text(&retry.stderr).contains("name it with --pr <n>"),
        "{}",
        text(&retry.stderr)
    );
    assert!(!f.bin.join("sent.json").exists(), "nothing posted on #9");
}

#[test]
fn a_landed_posts_retry_finds_its_comment_on_the_closed_pr_not_a_new_one() {
    let f = Posting::new();
    let first = f.post(&["--n", "1", "--as", "question"]);
    assert!(first.status.success(), "{}", text(&first.stderr));
    assert_eq!(
        (&choice(&f)["pr"], &choice(&f)["choice"]),
        (&json!(5), &json!("question")),
        "the PR stays with the choice"
    );
    let sent = std::fs::read_to_string(f.bin.join("sent.json")).unwrap();
    merged_with_a_new_pr(&f);
    std::fs::remove_file(f.bin.join("calls")).unwrap();
    let retry = f.post(&["--n", "1", "--as", "question"]);
    assert!(retry.status.success(), "{}", text(&retry.stderr));
    let said: Value = serde_json::from_str(&text(&retry.stdout)).unwrap();
    assert_eq!((&said["pr"], &said["already"]), (&json!(5), &json!(true)));
    assert_eq!(
        std::fs::read_to_string(f.bin.join("sent.json")).unwrap(),
        sent
    );
    let calls = std::fs::read_to_string(f.bin.join("calls")).unwrap();
    assert!(
        !calls.contains("pr list"),
        "no PR of the branch looked up: {calls}"
    );
}

#[test]
fn a_pr_gh_cannot_view_is_a_failure_to_retry() {
    let f = Posting::with(&json!({"prComments": {"pr": 5}}));
    std::fs::write(f.bin.join("fail-view"), "").unwrap();
    let out = f.post(&["--n", "1", "--as", "question"]);
    assert_eq!(out.status.code(), Some(1), "{}", text(&out.stderr));
    let err = text(&out.stderr);
    assert!(
        err.contains("PR #5: ")
            && err.contains("HTTP 503")
            && err.contains("a retry names it with --record"),
        "{err}"
    );
}

#[test]
fn naming_the_records_own_pr_takes_the_named_route_and_its_retry_after_a_merge() {
    let f = Posting::with(&json!({"prComments": {"pr": 5}}));
    let first = f.post(&["--n", "1", "--as", "question", "--pr", "5"]);
    assert!(first.status.success(), "{}", text(&first.stderr));
    let sent = std::fs::read_to_string(f.bin.join("sent.json")).unwrap();
    merged_with_a_new_pr(&f);
    let bare = f.post(&["--n", "1", "--as", "question"]);
    assert!(
        bare.status.success(),
        "the recorded PR: {}",
        text(&bare.stderr)
    );
    let named = f.post(&["--n", "1", "--as", "question", "--pr", "5"]);
    assert!(named.status.success(), "{}", text(&named.stderr));
    let said: Value = serde_json::from_str(&text(&named.stdout)).unwrap();
    assert_eq!((&said["pr"], &said["already"]), (&json!(5), &json!(true)));
    assert_eq!(
        std::fs::read_to_string(f.bin.join("sent.json")).unwrap(),
        sent
    );
}

#[test]
fn a_post_that_landed_and_timed_out_is_found_after_a_force_push() {
    for named in [false, true] {
        let f = Posting::new();
        std::fs::write(f.bin.join("fail-after-post"), "").unwrap();
        let first = f.post(&["--n", "1", "--as", "question"]);
        assert_eq!(first.status.code(), Some(1), "{}", text(&first.stderr));
        std::fs::remove_file(f.bin.join("fail-after-post")).unwrap();
        assert_eq!(choice(&f).get("choice"), None, "no choice yet");
        // Force-pushed: the PR's head no longer holds the reviewed commit, nor is it here.
        let pushed = format!(
            r#"{{"number":5,"url":"https://github.com/o/r/pull/5","headRefOid":"{}","headRefName":"feat/x","isCrossRepository":false,"state":"OPEN"}}"#,
            "e".repeat(40)
        );
        std::fs::write(f.bin.join("view"), &pushed).unwrap();
        std::fs::write(f.bin.join("list"), format!("[{pushed}]")).unwrap();
        let args: &[&str] = if named {
            &["--n", "1", "--as", "question", "--pr", "5"]
        } else {
            &["--n", "1", "--as", "question"]
        };
        let retry = f.post(args);
        assert!(retry.status.success(), "{}", text(&retry.stderr));
        let said: Value = serde_json::from_str(&text(&retry.stdout)).unwrap();
        assert_eq!((&said["pr"], &said["already"]), (&json!(5), &json!(true)));
        assert_eq!(
            (&choice(&f)["choice"], &choice(&f)["pr"]),
            (&json!("question"), &json!(5))
        );
    }
}
