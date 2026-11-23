//! A doubtful finding's PR whose head this repository lacks: fetched from `origin`'s
//! `pull/<n>/head`, then posted on the reviewed commit when the head holds it and its new commits
//! leave the line alone.

mod common;

use common::commits::has_commit;
use common::fixture;
use common::post::{head, posted, stand_in};
use craft_review::publish::{self, Doubtful};
use serde_json::json;

#[test]
fn a_pr_head_missing_here_is_fetched_from_origin_and_posted_to() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let reviewed = head(repo.path());
    let origin = out.path().join("origin.git");
    let other = out.path().join("other");
    let o = origin.to_str().unwrap();
    common::git(out.path(), &["init", "-q", "--bare", o]);
    common::git(repo.path(), &["push", "-q", o, "HEAD:refs/heads/main"]);
    common::git(repo.path(), &["remote", "add", "origin", o]);
    common::git(
        out.path(),
        &["clone", "-q", "-b", "main", o, other.to_str().unwrap()],
    );
    std::fs::write(other.join("src/other.rs"), "pub fn o() {}\n").unwrap();
    common::git(&other, &["add", "."]);
    common::git(&other, &["commit", "-qm", "feat: another file"]);
    common::git(&other, &["push", "-q", "origin", "HEAD:refs/pull/7/head"]);
    let pr_head = head(&other);
    assert!(
        !has_commit(repo.path(), &pr_head),
        "the PR's head is not here yet"
    );
    let gh = out.path().join("gh");
    let setup = stand_in(&gh, &pr_head);
    let fs = vec![
        json!({"n": 1, "severity": "High", "title": "t", "file": "src/lib.rs", "line": 1, "why": "w", "fix": "x", "source": "compat", "toolRule": "", "outsideDiff": false}),
    ];
    let d = Doubtful {
        findings: &fs,
        n: 1,
        question: true,
        lines_judged: true,
        reviewed: Some(&reviewed),
        branch: Some("main"),
        record_pr: None,
        dirty: false,
    };
    let p = publish::post_doubtful(repo.path(), &d, Some(7), &setup, out.path()).unwrap();
    assert!(p.posted, "{p:?}");
    assert_eq!(p.commit, reviewed, "on the reviewed commit");
    assert_eq!(posted(&gh)[0]["commit_id"], json!(reviewed));
}
