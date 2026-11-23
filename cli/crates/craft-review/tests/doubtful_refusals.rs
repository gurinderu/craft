//! What gh cannot change on a retry is refused, not failed: a PR gh says does not exist, and a
//! record's branch gh would read as a flag.

mod common;

use common::fixture;
use common::post::{head, stand_in};
use craft_review::publish::{self, Doubtful, PostError};
use serde_json::json;

fn post(
    (repo, scratch): (&std::path::Path, &std::path::Path),
    (h, branch, pr): (&str, &str, Option<u64>),
    setup: &craft_review::publish::PostSetup,
) -> Result<publish::Posting, PostError> {
    let fs = vec![
        json!({"n": 1, "severity": "High", "title": "t", "file": "src/lib.rs", "line": 1, "why": "w", "fix": "x", "source": "compat", "toolRule": "", "outsideDiff": false}),
    ];
    let d = Doubtful {
        findings: &fs,
        n: 1,
        question: true,
        lines_judged: true,
        reviewed: Some(h),
        branch: Some(branch),
        record_pr: None,
        dirty: false,
        posted_on: None,
        before_post: None,
    };
    publish::post_doubtful(repo, &d, pr, setup, scratch)
}

#[test]
fn a_pr_gh_says_does_not_exist_is_refused() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let (gh, h) = (out.path().join("gh"), head(repo.path()));
    let setup = stand_in(&gh, &h);
    std::fs::write(gh.join("no-such-pr"), "").unwrap();
    let e = post((repo.path(), out.path()), (&h, "main", Some(7)), &setup).unwrap_err();
    assert!(
        matches!(&e, PostError::Pr(w) if w.starts_with("PR #7: ") && w.contains("Could not resolve to a PullRequest")),
        "{e}"
    );
}

#[test]
fn a_branch_gh_would_read_as_a_flag_is_refused() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let (gh, h) = (out.path().join("gh"), head(repo.path()));
    let setup = stand_in(&gh, &h);
    let e = post((repo.path(), out.path()), (&h, "-x", None), &setup).unwrap_err();
    assert!(
        matches!(&e, PostError::Pr(w) if w.contains("is no branch name")),
        "{e}"
    );
    assert!(!gh.join("calls").exists(), "gh never asked");
}
