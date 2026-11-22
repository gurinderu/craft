//! Posting one doubtful finding the reviewer chose (`craft review post`) through a stand-in `gh`:
//! a question carries its ask, kind line and the marker last, a second post adds nothing, a line
//! outside the diff or refused by GitHub goes on its file, a PR head that moved is posted to on the
//! reviewed commit only when its new commits leave the finding's line alone, and a number the
//! record does not list is refused before gh is asked.

mod common;

use std::path::Path;

use common::fixture;
use common::post::{head, posted, stand_in};
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
    (repo, scratch): (&Path, &Path),
    n: u64,
    question: bool,
    reviewed: Option<&str>,
    setup: &PostSetup,
) -> Result<Posting, PostError> {
    let fs = findings();
    let d = Doubtful {
        findings: &fs,
        n,
        question,
        lines_judged: true,
        reviewed,
    };
    publish::post_doubtful(repo, &d, None, setup, scratch)
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
    let setup = stand_in(&gh, &head(repo.path()));
    let p = post((repo.path(), out.path()), 2, false, None, &setup).unwrap();
    assert!(p.to_file && p.posted);
    assert_eq!(posted(&gh)[0]["subject_type"], json!("file"));
    assert!(posted(&gh)[0].get("line").is_none());
    std::fs::write(gh.join("no-lines"), "").unwrap();
    let p = post((repo.path(), out.path()), 1, false, None, &setup).unwrap();
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
    let e = post((repo.path(), out.path()), 1, true, Some(&reviewed), &setup)
        .unwrap_err()
        .to_string();
    assert!(
        e.contains("`src/lib.rs:1` old replicas drop the field"),
        "{e}"
    );
    assert_eq!(posted(&gh).len(), 1, "nothing more posted");
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
    let e = post((repo.path(), out.path()), 1, true, None, &setup).unwrap_err();
    assert!(
        matches!(&e, PostError::Gh(w) if w.contains("HTTP 401")),
        "{e}"
    );
}
