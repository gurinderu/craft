//! What a second post of a doubtful finding trusts: a retry names its PR with `--pr` once the PR
//! closed (no closed PR is searched for it), and on a PR named with `--pr` a matching comment
//! counts only when that PR's head holds the reviewed commit.

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
        before_post: None,
    };
    publish::post_doubtful(repo, &d, pr, setup, scratch)
}

#[test]
fn a_retry_whose_pr_closed_names_it_and_finds_its_comment() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let (gh, h) = (out.path().join("gh"), head(repo.path()));
    let setup = stand_in(&gh, &h);
    let at = (repo.path(), out.path());
    std::fs::write(gh.join("state"), "MERGED").unwrap();
    let e = post(at, &h, None, &setup).unwrap_err();
    assert!(
        matches!(&e, PostError::Pr(w) if w.contains("no open PR of this repository") && w.contains("name it with --pr <n>")),
        "{e}"
    );
    let e = post(at, &h, Some(7), &setup).unwrap_err();
    assert!(
        matches!(&e, PostError::Pr(w) if w.contains("PR #7 is MERGED, not open")),
        "a first post on a named closed PR: {e}"
    );
    assert!(posted(&gh).is_empty());
    std::fs::remove_file(gh.join("state")).unwrap();
    assert!(post(at, &h, None, &setup).unwrap().posted);
    std::fs::write(gh.join("state"), "MERGED").unwrap();
    let e = post(at, &h, None, &setup).unwrap_err();
    assert!(
        matches!(&e, PostError::Pr(w) if w.contains("the PR is closed or gone")),
        "no closed PR is searched: {e}"
    );
    let again = post(at, &h, Some(7), &setup).unwrap();
    assert_eq!((again.pr, again.already), (7, true), "{again:?}");
    let calls = std::fs::read_to_string(gh.join("calls")).unwrap();
    assert!(!calls.contains("--state all"), "{calls}");
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
