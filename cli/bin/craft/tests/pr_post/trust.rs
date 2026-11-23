//! What `craft review post` leans on for a retry: a PR it could not note posts nothing, and the
//! run's own PR named with `--pr` is read for its comment before its head is judged.

use serde_json::{Value, json};

use super::support::{Posting, text};

#[test]
fn a_pr_that_cannot_be_noted_before_the_post_is_not_posted_to() {
    use std::os::unix::fs::PermissionsExt;
    let f = Posting::new();
    let store = f.store.path();
    std::fs::set_permissions(store, std::fs::Permissions::from_mode(0o555)).unwrap();
    let out = f.post(&["--n", "1", "--as", "question"]);
    std::fs::set_permissions(store, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(out.status.code(), Some(1), "{}", text(&out.stderr));
    let err = text(&out.stderr);
    assert!(
        err.contains("PR #5 could not be noted in the record before posting")
            && err.contains("a retry names it with --record"),
        "{err}"
    );
    assert!(!f.bin.join("sent.json").exists(), "nothing posted");
}

#[test]
fn the_records_own_pr_named_is_trusted_for_its_comment_though_force_pushed() {
    let f = Posting::with(&json!({"prComments": {"pr": 5}}));
    let first = f.post(&["--n", "1", "--as", "question"]);
    assert!(first.status.success(), "{}", text(&first.stderr));
    // Only the run's own PR names #5 now: no post mark to lean on.
    let mut r: Value = serde_json::from_str(&std::fs::read_to_string(&f.record).unwrap()).unwrap();
    r["sorting"]["choices"]["1"]
        .as_object_mut()
        .unwrap()
        .remove("pr");
    std::fs::write(&f.record, r.to_string()).unwrap();
    let pushed = format!(
        r#"{{"number":5,"url":"https://github.com/o/r/pull/5","headRefOid":"{}","headRefName":"feat/x","isCrossRepository":false,"state":"OPEN"}}"#,
        "e".repeat(40)
    );
    std::fs::write(f.bin.join("view"), pushed).unwrap();
    let named = f.post(&["--n", "1", "--as", "question", "--pr", "5"]);
    assert!(named.status.success(), "{}", text(&named.stderr));
    let said: Value = serde_json::from_str(&text(&named.stdout)).unwrap();
    assert_eq!((&said["pr"], &said["already"]), (&json!(5), &json!(true)));
}
