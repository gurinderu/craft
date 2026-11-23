//! The PR a finding's earlier post recorded: a failed note of it posts nothing, and a `--pr`
//! naming another PR is not taken for it.

mod common;

use common::fixture;
use common::post::{head, posted, stand_in};
use craft_review::publish::{self, Doubtful, PostError, PostSetup, Posting};
use serde_json::json;

type Remember<'a> = Option<&'a dyn Fn(u64) -> Result<(), String>>;

fn post(
    (repo, scratch): (&std::path::Path, &std::path::Path),
    (h, posted_on, pr): (&str, Option<u64>, Option<u64>),
    before_post: Remember<'_>,
    setup: &PostSetup,
) -> Result<Posting, PostError> {
    let fs = vec![
        json!({"n": 1, "severity": "High", "title": "t", "file": "src/lib.rs", "line": 1, "why": "w", "fix": "x", "source": "compat", "toolRule": "", "outsideDiff": false}),
    ];
    let d = Doubtful {
        findings: &fs,
        n: 1,
        question: true,
        lines_judged: true,
        reviewed: Some(h),
        branch: Some("main"),
        record_pr: None,
        dirty: false,
        posted_on,
        before_post,
    };
    publish::post_doubtful(repo, &d, pr, setup, scratch)
}

#[test]
fn a_pr_that_cannot_be_noted_before_the_post_is_not_posted_to() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let (gh, h) = (out.path().join("gh"), head(repo.path()));
    let setup = stand_in(&gh, &h);
    let fail = |_: u64| Err("the record is read-only".to_owned());
    let e = post(
        (repo.path(), out.path()),
        (&h, None, None),
        Some(&fail),
        &setup,
    )
    .unwrap_err();
    assert!(
        matches!(&e, PostError::Remember(w) if w.contains("PR #7 could not be noted") && w.contains("the record is read-only")),
        "{e}"
    );
    assert!(posted(&gh).is_empty(), "nothing posted");
}

#[test]
fn a_pr_named_besides_the_recorded_one_must_hold_the_reviewed_commit() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let (gh, h) = (out.path().join("gh"), head(repo.path()));
    let setup = stand_in(&gh, &h);
    let at = (repo.path(), out.path());
    assert!(post(at, (&h, None, Some(7)), None, &setup).unwrap().posted);
    let tree = common::commits::tree_of(repo.path(), "HEAD~1");
    let sibling = common::commits::commit_tree(repo.path(), &tree, "HEAD~1");
    std::fs::write(gh.join("head"), sibling).unwrap();
    // Recorded on #9: --pr 7 is another PR, so its head is judged before its comment counts.
    let e = post(at, (&h, Some(9), Some(7)), None, &setup).unwrap_err();
    assert!(
        matches!(&e, PostError::Pr(w) if w.contains("does not hold the reviewed commit")),
        "{e}"
    );
    // Recorded on #7: the same PR is trusted, its comment read first.
    let again = post(at, (&h, Some(7), Some(7)), None, &setup).unwrap();
    assert_eq!((again.pr, again.already), (7, true), "{again:?}");
}
