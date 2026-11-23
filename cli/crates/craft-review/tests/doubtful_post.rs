//! Posting one doubtful finding the reviewer chose (`craft review post`) through a stand-in `gh`:
//! a question carries its ask, kind line and the marker last, a second post adds nothing, a line
//! outside the diff or refused by GitHub goes on its file, a PR head that moved is posted to on the
//! reviewed commit only when its new commits leave the finding's line alone, the PR is the record's
//! own branch's (or a named one holding the reviewed commit), a record naming no reviewed commit
//! posts nothing, and a number the record does not list is refused before gh is asked.

mod common;

use std::path::Path;

use common::fixture;
use common::post::{head, posted, stand_in, unpost};
use craft_review::publish::{self, Doubtful, PostError, PostSetup, Posting};
use serde_json::{Value, json};

/// The record's doubtful findings: 1 on the changed line 1, 2 outside the diff on line 40.
fn findings() -> Vec<Value> {
    let f = |n: u64, line: u64, title: &str, outside: bool| json!({"n": n, "severity": "High", "title": title, "file": "src/lib.rs", "line": line, "why": "w", "fix": "x", "source": "compat", "toolRule": "", "outsideDiff": outside});
    vec![
        f(1, 1, "old replicas drop the field", false),
        f(2, 40, "a pre-existing leak", true),
    ]
}

fn post(
    at: (&Path, &Path),
    n: u64,
    question: bool,
    reviewed: Option<&str>,
    setup: &PostSetup,
) -> Result<Posting, PostError> {
    post_to(at, (n, question), (reviewed, Some("main"), None), setup)
}

/// Posts finding `n` of a record of `branch` reviewed at `reviewed`, on `pr` when named.
fn post_to(
    (repo, scratch): (&Path, &Path),
    (n, question): (u64, bool),
    (reviewed, branch, pr): (Option<&str>, Option<&str>, Option<u64>),
    setup: &PostSetup,
) -> Result<Posting, PostError> {
    let fs = findings();
    let d = Doubtful {
        findings: &fs,
        n,
        question,
        lines_judged: true,
        reviewed,
        branch,
        record_pr: None,
        dirty: false,
    };
    publish::post_doubtful(repo, &d, pr, setup, scratch)
}

#[test]
fn a_question_goes_on_its_line_with_its_ask_kind_line_and_marker_and_only_once() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let h = head(repo.path());
    let setup = stand_in(&out.path().join("gh"), &h);
    let p = post((repo.path(), out.path()), 1, true, Some(&h), &setup).unwrap();
    assert_eq!(
        (p.pr, p.posted, p.already, p.to_file),
        (7, true, false, false)
    );
    let sent = posted(&out.path().join("gh"));
    assert_eq!(sent.len(), 1);
    assert_eq!(
        (&sent[0]["commit_id"], &sent[0]["line"], &sent[0]["side"]),
        (&json!(h), &json!(1), &json!("RIGHT"))
    );
    let body = sent[0]["body"].as_str().unwrap();
    assert!(
        body.starts_with("[High] old replicas drop the field\n\n**Question to the author:**"),
        "{body}"
    );
    assert!(
        body.ends_with(
            "<!-- craft-lens: compat -->\n<!-- craft-kind: question -->\n<!-- craft-finding -->"
        ),
        "{body}"
    );
    let again = post((repo.path(), out.path()), 1, false, Some(&h), &setup).unwrap();
    assert_eq!((again.posted, again.already), (false, true));
    assert_eq!(
        posted(&out.path().join("gh")).len(),
        1,
        "one comment after two posts"
    );
}

#[test]
fn a_finding_outside_the_diff_goes_on_its_file_and_a_refused_line_too() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let gh = out.path().join("gh");
    let h = head(repo.path());
    let setup = stand_in(&gh, &h);
    let p = post((repo.path(), out.path()), 2, false, Some(&h), &setup).unwrap();
    assert!(p.to_file && p.posted);
    assert_eq!(posted(&gh)[0]["subject_type"], json!("file"));
    assert!(posted(&gh)[0].get("line").is_none());
    std::fs::write(gh.join("no-lines"), "").unwrap();
    let p = post((repo.path(), out.path()), 1, false, Some(&h), &setup).unwrap();
    assert!(p.to_file && p.posted, "{p:?}");
    assert_eq!(posted(&gh)[1]["subject_type"], json!("file"));
}

#[test]
fn a_moved_head_takes_the_reviewed_commit_unless_it_rewrote_the_line() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let reviewed = head(repo.path());
    std::fs::write(repo.path().join("src/other.rs"), "pub fn o() {}\n").unwrap();
    common::git(repo.path(), &["add", "."]);
    common::git(repo.path(), &["commit", "-qm", "feat: another file"]);
    let gh = out.path().join("gh");
    let setup = stand_in(&gh, &head(repo.path()));
    let p = post((repo.path(), out.path()), 1, true, Some(&reviewed), &setup).unwrap();
    assert_eq!(p.commit, reviewed);
    assert!(
        p.reason.contains("change none of the defects' lines"),
        "{}",
        p.reason
    );
    std::fs::write(repo.path().join("src/lib.rs"), "pub fn f() -> u8 { 2 }\n").unwrap();
    common::git(repo.path(), &["commit", "-qam", "fix: f"]);
    std::fs::write(gh.join("head"), head(repo.path())).unwrap();
    // Not on the PR yet: a comment there would be found first (`doubtful_gates.rs`).
    unpost(&gh);
    let e = post((repo.path(), out.path()), 1, true, Some(&reviewed), &setup)
        .unwrap_err()
        .to_string();
    assert!(
        e.contains("`src/lib.rs:1` old replicas drop the field"),
        "{e}"
    );
    assert!(posted(&gh).is_empty(), "nothing posted");
}

#[test]
fn a_number_the_record_lacks_is_refused_before_gh_and_a_gh_failure_is_named() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let gh = out.path().join("gh");
    let setup = stand_in(&gh, &head(repo.path()));
    let e = post((repo.path(), out.path()), 9, true, None, &setup).unwrap_err();
    assert!(
        matches!(&e, PostError::Finding(w) if w == "the run record lists no doubtful finding numbered 9"),
        "{e}"
    );
    assert!(!gh.join("calls").exists(), "gh never asked");
    std::fs::write(gh.join("fail"), "").unwrap();
    let h = head(repo.path());
    let e = post((repo.path(), out.path()), 1, true, Some(&h), &setup).unwrap_err();
    assert!(
        matches!(&e, PostError::Gh(w) if w.starts_with("gh pr list failed") && w.contains("HTTP 401")),
        "a list gh could not give is a failure on the way, not a refusal: {e}"
    );
}

#[test]
fn without_pr_only_the_one_open_pr_of_the_records_branch_is_posted_to() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let (gh, h) = (out.path().join("gh"), head(repo.path()));
    let setup = stand_in(&gh, &h);
    let at = (repo.path(), out.path());
    let e = post_to(at, (1, true), (Some(&h), None, None), &setup).unwrap_err();
    assert!(
        matches!(&e, PostError::Pr(w) if w.contains("names no branch")),
        "{e}"
    );
    std::fs::write(gh.join("prs"), "[]").unwrap();
    let e = post(at, 1, true, Some(&h), &setup).unwrap_err();
    assert!(
        matches!(&e, PostError::Pr(w) if w.contains("no open PR of this repository has the record's branch main")),
        "{e}"
    );
    let two = format!(
        r#"[{{"number":7,"url":"u","headRefOid":"{h}","headRefName":"main","state":"OPEN"}},{{"number":8,"url":"u","headRefOid":"{h}","headRefName":"main","state":"OPEN"}}]"#
    );
    std::fs::write(gh.join("prs"), two).unwrap();
    let e = post(at, 1, true, Some(&h), &setup).unwrap_err();
    assert!(
        matches!(&e, PostError::Pr(w) if w.starts_with("2 open PRs")),
        "{e}"
    );
    assert!(posted(&gh).is_empty());
    let calls = std::fs::read_to_string(gh.join("calls")).unwrap();
    assert!(
        calls.contains("pr list --head main --state open"),
        "{calls}"
    );
}

#[test]
fn a_mistyped_pr_of_another_branch_is_refused_even_when_its_head_holds_the_commit() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let (gh, h) = (out.path().join("gh"), head(repo.path()));
    let setup = stand_in(&gh, &h);
    let at = (repo.path(), out.path());
    std::fs::write(gh.join("branch"), "other").unwrap();
    let e = post_to(at, (1, true), (Some(&h), Some("main"), Some(7)), &setup).unwrap_err();
    assert!(
        matches!(&e, PostError::Pr(w) if w.contains("PR #7 has head branch other, not the record's main")),
        "{e}"
    );
    std::fs::write(gh.join("branch"), "main").unwrap();
    let p = post_to(at, (1, true), (Some(&h), Some("main"), Some(7)), &setup).unwrap();
    assert!(p.posted, "the PR of the record's branch, named");
    assert_eq!(posted(&gh).len(), 1);
}

#[test]
fn a_fork_pr_of_a_same_named_branch_is_not_the_records() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let (gh, h) = (out.path().join("gh"), head(repo.path()));
    let setup = stand_in(&gh, &h);
    let at = (repo.path(), out.path());
    let pr = |n: u64, fork: bool| {
        format!(
            r#"{{"number":{n},"url":"u{n}","headRefOid":"{h}","headRefName":"main","isCrossRepository":{fork},"state":"OPEN","headRepositoryOwner":{{"login":"x"}}}}"#
        )
    };
    std::fs::write(gh.join("prs"), format!("[{}]", pr(9, true))).unwrap();
    let e = post(at, 1, true, Some(&h), &setup).unwrap_err();
    assert!(
        matches!(&e, PostError::Pr(w) if w.starts_with("no open PR of this repository")),
        "{e}"
    );
    std::fs::write(
        gh.join("prs"),
        format!("[{},{}]", pr(9, true), pr(8, false)),
    )
    .unwrap();
    let p = post(at, 1, true, Some(&h), &setup).unwrap();
    assert_eq!(
        (p.pr, p.url.as_str()),
        (8, "u8"),
        "the same-repository PR, not the fork's"
    );
}

#[test]
fn a_pr_whose_head_does_not_hold_the_reviewed_commit_is_refused() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let gh = out.path().join("gh");
    let reviewed = head(repo.path());
    // A sibling of the reviewed commit: in this repository, not on its history.
    let tree = common::commits::tree_of(repo.path(), "HEAD~1");
    let sibling = common::commits::commit_tree(repo.path(), &tree, "HEAD~1");
    let setup = stand_in(&gh, &sibling);
    for pr in [None, Some(7)] {
        let e = post_to(
            (repo.path(), out.path()),
            (1, true),
            (Some(&reviewed), Some("main"), pr),
            &setup,
        )
        .unwrap_err();
        assert!(
            matches!(&e, PostError::Pr(w) if w.contains("does not hold the reviewed commit")),
            "{e}"
        );
    }
    assert!(posted(&gh).is_empty());
}

#[test]
fn a_record_naming_no_reviewed_commit_posts_nothing() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let gh = out.path().join("gh");
    let setup = stand_in(&gh, &head(repo.path()));
    for reviewed in [None, Some("abc1234")] {
        let e = post((repo.path(), out.path()), 1, true, reviewed, &setup).unwrap_err();
        assert!(
            matches!(&e, PostError::Refused(w) if w.contains("names no reviewed commit")),
            "{e}"
        );
    }
    assert!(posted(&gh).is_empty());
}

/// Posts finding 1 of a detached-HEAD record (no branch) reviewed at `reviewed`, which published
/// on `record_pr`, on `pr` when named.
fn post_detached(
    (repo, scratch): (&Path, &Path),
    reviewed: &str,
    (record_pr, pr): (Option<u64>, Option<u64>),
    setup: &PostSetup,
) -> Result<Posting, PostError> {
    let fs = findings();
    let d = Doubtful {
        findings: &fs,
        n: 1,
        question: true,
        lines_judged: true,
        reviewed: Some(reviewed),
        branch: Some("HEAD"),
        record_pr,
        dirty: false,
    };
    publish::post_doubtful(repo, &d, pr, setup, scratch)
}

#[test]
fn a_detached_runs_finding_goes_on_the_pr_it_published_on() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let (gh, h) = (out.path().join("gh"), head(repo.path()));
    let setup = stand_in(&gh, &h);
    std::fs::write(gh.join("branch"), "feat/elsewhere").unwrap();
    let at = (repo.path(), out.path());
    let e = post_detached(at, &h, (Some(7), Some(8)), &setup).unwrap_err();
    assert!(
        matches!(&e, PostError::Pr(w) if w.contains("PR #8 is not PR #7")),
        "{e}"
    );
    let p = post_detached(at, &h, (Some(7), None), &setup).unwrap();
    assert_eq!((p.pr, p.posted), (7, true));
    let calls = std::fs::read_to_string(gh.join("calls")).unwrap();
    assert!(calls.contains("pr view 7 --json"), "{calls}");
    assert!(
        !calls.contains("pr list"),
        "the record's PR, no lookup by branch: {calls}"
    );
}

#[test]
fn a_detached_run_that_published_nothing_takes_a_named_same_repo_pr_holding_its_commit() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let (gh, h) = (out.path().join("gh"), head(repo.path()));
    let setup = stand_in(&gh, &h);
    let at = (repo.path(), out.path());
    let e = post_detached(at, &h, (None, None), &setup).unwrap_err();
    assert!(
        matches!(&e, PostError::Pr(w) if w.contains("names no branch and no PR")),
        "{e}"
    );
    let p = post_detached(at, &h, (None, Some(7)), &setup).unwrap();
    assert!(p.posted);
    unpost(&gh);
    std::fs::write(gh.join("fork"), "").unwrap();
    let e = post_detached(at, &h, (None, Some(7)), &setup).unwrap_err();
    assert!(
        matches!(&e, PostError::Pr(w) if w.contains("comes from a fork")),
        "{e}"
    );
    let e = post_detached(at, &h, (Some(7), None), &setup).unwrap_err();
    assert!(
        matches!(&e, PostError::Pr(w) if w.contains("comes from a fork")),
        "{e}"
    );
    std::fs::remove_file(gh.join("fork")).unwrap();
    std::fs::write(gh.join("head"), "e".repeat(40)).unwrap();
    let e = post_detached(at, &h, (None, Some(7)), &setup).unwrap_err();
    assert!(
        matches!(&e, PostError::Fetch(w) if w.contains("fetching it from origin failed")),
        "{e}"
    );
}
