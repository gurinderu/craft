//! What keeps a doubtful finding off a PR it does not belong on, and what a second post finds:
//! a named fork's PR or a closed one is refused, a review of uncommitted work posts nothing, a read
//! of the PR's comments that fails posts nothing, and a retry finds its own earlier comment — on
//! its file after GitHub refused its line, or after the PR closed or its head moved over the line.

mod common;

use std::path::Path;

use common::fixture;
use common::post::{head, posted, stand_in};
use craft_review::publish::{self, Doubtful, PostError, PostSetup, Posting};
use serde_json::{Value, json};

fn findings() -> Vec<Value> {
    vec![
        json!({"n": 1, "severity": "High", "title": "old replicas drop the field", "file": "src/lib.rs", "line": 1, "why": "w", "fix": "x", "source": "compat", "toolRule": "", "outsideDiff": false}),
    ]
}

/// Posts finding 1 of a record of `main` reviewed at `reviewed`, `dirty` when it read uncommitted
/// work, on `pr` when named.
fn post(
    (repo, scratch): (&Path, &Path),
    (reviewed, dirty): (&str, bool),
    pr: Option<u64>,
    setup: &PostSetup,
) -> Result<Posting, PostError> {
    let fs = findings();
    let d = Doubtful {
        findings: &fs,
        n: 1,
        question: true,
        lines_judged: true,
        reviewed: Some(reviewed),
        branch: Some("main"),
        record_pr: None,
        dirty,
    };
    publish::post_doubtful(repo, &d, pr, setup, scratch)
}

#[test]
fn a_named_fork_pr_of_the_records_branch_is_refused() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let (gh, h) = (out.path().join("gh"), head(repo.path()));
    let setup = stand_in(&gh, &h);
    std::fs::write(gh.join("fork"), "").unwrap();
    let e = post((repo.path(), out.path()), (&h, false), Some(7), &setup).unwrap_err();
    assert!(
        matches!(&e, PostError::Pr(w) if w.contains("comes from a fork")),
        "{e}"
    );
    assert!(posted(&gh).is_empty());
    let calls = std::fs::read_to_string(gh.join("calls")).unwrap();
    assert!(calls.contains("isCrossRepository"), "{calls}");
}

#[test]
fn a_closed_or_merged_pr_is_refused() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let (gh, h) = (out.path().join("gh"), head(repo.path()));
    let setup = stand_in(&gh, &h);
    for state in ["MERGED", "CLOSED"] {
        std::fs::write(gh.join("state"), state).unwrap();
        let e = post((repo.path(), out.path()), (&h, false), Some(7), &setup).unwrap_err();
        assert!(
            matches!(&e, PostError::Pr(w) if w.contains(&format!("PR #7 is {state}, not open"))),
            "{e}"
        );
    }
    assert!(posted(&gh).is_empty());
}

#[test]
fn a_review_of_uncommitted_work_posts_nothing_and_asks_gh_nothing() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let (gh, h) = (out.path().join("gh"), head(repo.path()));
    let setup = stand_in(&gh, &h);
    let e = post((repo.path(), out.path()), (&h, true), None, &setup).unwrap_err();
    assert!(
        matches!(&e, PostError::Refused(w) if w.contains("uncommitted changes")),
        "{e}"
    );
    assert!(!gh.join("calls").exists(), "gh never asked");
}

#[test]
fn a_failed_read_of_the_prs_comments_posts_nothing() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let (gh, h) = (out.path().join("gh"), head(repo.path()));
    let setup = stand_in(&gh, &h);
    std::fs::write(gh.join("fail-comments"), "").unwrap();
    let e = post((repo.path(), out.path()), (&h, false), None, &setup).unwrap_err();
    assert!(
        matches!(&e, PostError::Gh(w) if w.contains("HTTP 502") && w.contains("could not be read")),
        "{e}"
    );
    assert!(posted(&gh).is_empty());
}

#[test]
fn a_finding_posted_on_its_file_after_a_422_is_not_posted_again() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let (gh, h) = (out.path().join("gh"), head(repo.path()));
    let setup = stand_in(&gh, &h);
    std::fs::write(gh.join("no-lines"), "").unwrap();
    let at = (repo.path(), out.path());
    let p = post(at, (&h, false), None, &setup).unwrap();
    assert!(p.posted && p.to_file, "{p:?}");
    std::fs::remove_file(gh.join("no-lines")).unwrap();
    let again = post(at, (&h, false), None, &setup).unwrap();
    assert_eq!((again.posted, again.already), (false, true), "{again:?}");
    assert_eq!(posted(&gh).len(), 1, "one comment after two posts");
}

#[test]
fn a_retry_finds_its_comment_after_the_pr_closed_or_its_head_moved_over_the_line() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let (gh, reviewed) = (out.path().join("gh"), head(repo.path()));
    let setup = stand_in(&gh, &reviewed);
    let at = (repo.path(), out.path());
    assert!(post(at, (&reviewed, false), None, &setup).unwrap().posted);
    std::fs::write(repo.path().join("src/lib.rs"), "pub fn f() -> u8 { 2 }\n").unwrap();
    common::git(repo.path(), &["commit", "-qam", "fix: f"]);
    std::fs::write(gh.join("head"), head(repo.path())).unwrap();
    std::fs::write(gh.join("state"), "MERGED").unwrap();
    for pr in [None, Some(7)] {
        let again = post(at, (&reviewed, false), pr, &setup).unwrap();
        assert_eq!((again.posted, again.already), (false, true), "{again:?}");
    }
    assert_eq!(posted(&gh).len(), 1);
}
