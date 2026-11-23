//! What a second post of a doubtful finding trusts: on the record's own PR, its earlier comment
//! even once the PR closed; on a PR named with `--pr`, a matching comment only when that PR's head
//! holds the reviewed commit.

mod common;

use std::path::Path;

use common::fixture;
use common::post::{head, posted, stand_in};
use craft_review::publish::{self, Doubtful, PostError, PostSetup, Posting};
use serde_json::json;

fn post(
    (repo, scratch): (&Path, &Path),
    reviewed: &str,
    pr: Option<u64>,
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
        reviewed: Some(reviewed),
        branch: Some("main"),
        record_pr: None,
        dirty: false,
    };
    publish::post_doubtful(repo, &d, pr, setup, scratch)
}

#[test]
fn a_merged_pr_of_the_branch_takes_no_first_post_but_holds_a_retrys_comment() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let (gh, h) = (out.path().join("gh"), head(repo.path()));
    let setup = stand_in(&gh, &h);
    let at = (repo.path(), out.path());
    std::fs::write(gh.join("state"), "MERGED").unwrap();
    let e = post(at, &h, None, &setup).unwrap_err();
    assert!(
        matches!(&e, PostError::Pr(w) if w.contains("no open PR of this repository")),
        "{e}"
    );
    assert!(posted(&gh).is_empty());
    std::fs::remove_file(gh.join("state")).unwrap();
    assert!(post(at, &h, None, &setup).unwrap().posted);
    std::fs::write(gh.join("state"), "MERGED").unwrap();
    let again = post(at, &h, None, &setup).unwrap();
    assert_eq!((again.pr, again.already), (7, true), "{again:?}");
    let calls = std::fs::read_to_string(gh.join("calls")).unwrap();
    assert!(calls.contains("--state all"), "{calls}");
}

#[test]
fn a_named_pr_whose_head_lacks_the_reviewed_commit_is_refused_though_it_holds_the_comment() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let (gh, h) = (out.path().join("gh"), head(repo.path()));
    let setup = stand_in(&gh, &h);
    let at = (repo.path(), out.path());
    assert!(post(at, &h, Some(7), &setup).unwrap().posted);
    let tree = common::commits::tree_of(repo.path(), "HEAD~1");
    let sibling = common::commits::commit_tree(repo.path(), &tree, "HEAD~1");
    std::fs::write(gh.join("head"), sibling).unwrap();
    let e = post(at, &h, Some(7), &setup).unwrap_err();
    assert!(
        matches!(&e, PostError::Pr(w) if w.contains("does not hold the reviewed commit")),
        "{e}"
    );
    assert_eq!(posted(&gh).len(), 1);
}
