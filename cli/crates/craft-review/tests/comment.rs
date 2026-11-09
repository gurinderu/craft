//! Publishing a finished run's findings after the fact (`craft review comment`): a run started
//! without `comment` is sorted and posted through a stand-in `gh` as a run asked to comment is, a
//! second time adds nothing, a line GitHub refuses goes on its file, a PR head that moved is posted
//! to only when the new commits leave the defects' lines alone, and an unfinished run is refused.

#![expect(
    clippy::unwrap_used,
    reason = "the helpers are steps of the tests, failing loudly like them"
)]

mod common;

use std::path::{Path, PathBuf};

use common::fixture;
use common::post::{finished, found, head, posted, report, stand_in};
use craft_review::publish::{self, PostSetup};
use craft_review::step;
use serde_json::{Value, json};

/// A run over `repo` finished without `comment`, and the stand-in `gh` in `out/gh` at its head.
fn uncommented(repo: &Path, out: &Path) -> (PathBuf, PathBuf, PostSetup) {
    let gh = out.join("gh");
    let setup = stand_in(&gh, &head(repo));
    finished(repo, out, "run", false, &setup, &found());
    assert!(!gh.join("calls").exists(), "nothing posted while it ran");
    (out.join("run"), gh, setup)
}

fn state(run: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(run.join("state.json")).unwrap()).unwrap()
}

#[test]
fn a_run_finished_without_comment_posts_its_defects_as_a_comment_run_does() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let (run, gh, setup) = uncommented(repo.path(), out.path());
    let s = publish::comment(&run, None, &setup).unwrap();
    assert_eq!((&s["done"], &s["verdict"]), (&json!(true), &json!("Block")));
    let sorting = &s["sorting"];
    assert_eq!(
        (
            &sorting["defect"],
            &sorting["doubtful"],
            &sorting["inDiffJudged"]
        ),
        (&json!(1), &json!(1), &json!(true))
    );
    assert_eq!(sorting["findings"][0]["title"], json!("g leaks a handle"));
    let pr = &s["prComments"];
    assert_eq!(
        (&pr["pr"], &pr["requested"], &pr["posted"], &pr["already"]),
        (&json!(7), &json!(1), &json!(1), &json!(0))
    );
    let sent = posted(&gh);
    assert_eq!(sent.len(), 1);
    assert_eq!(
        (&sent[0]["commit_id"], &sent[0]["line"]),
        (&json!(head(repo.path())), &json!(1))
    );
    // The severity the run settled, as its finished step reports it.
    let severity = s["findings"][0]["severity"].as_str().unwrap();
    assert!(
        sent[0]["body"]
            .as_str()
            .unwrap()
            .starts_with(&format!("[{severity}] f returns the wrong value")),
        "{}",
        sent[0]["body"]
    );
    common::assert_contains_all(
        &report(&s),
        &[
            "## Doubtful — for the reviewer, not posted",
            "## PR comments\n- posted 1 of 1 defect(s)",
        ],
    );
    let kept = state(&run);
    assert_eq!(
        (
            &kept["publish"]["asked"],
            &kept["publish"]["posted"]["posted"]
        ),
        (&json!(true), &json!(1))
    );
}

#[test]
fn publishing_a_run_twice_posts_nothing_again() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let (run, gh, setup) = uncommented(repo.path(), out.path());
    publish::comment(&run, None, &setup).unwrap();
    let s = publish::comment(&run, None, &setup).unwrap();
    let pr = &s["prComments"];
    assert_eq!((&pr["posted"], &pr["already"]), (&json!(0), &json!(1)));
    assert_eq!(posted(&gh).len(), 1, "one comment on the PR after two");
}

#[test]
fn a_line_github_refuses_goes_on_its_file_and_is_not_posted_twice() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let (run, gh, setup) = uncommented(repo.path(), out.path());
    std::fs::write(gh.join("no-lines"), "").unwrap();
    let s = publish::comment(&run, None, &setup).unwrap();
    let pr = &s["prComments"];
    assert_eq!(
        (&pr["posted"], &pr["toFile"], &pr["failed"]),
        (&json!(1), &json!(1), &json!(0))
    );
    let sent = posted(&gh);
    assert_eq!(
        (sent.len(), &sent[0]["subject_type"], &sent[0]["path"]),
        (1, &json!("file"), &json!("src/lib.rs"))
    );
    assert!(report(&s).contains("1 posted on its file, GitHub refusing its line"));
    let s = publish::comment(&run, None, &setup).unwrap();
    assert_eq!(s["prComments"]["already"], json!(1));
    assert_eq!(posted(&gh).len(), 1, "the file comment is the finding's");
}

#[test]
fn a_422_said_on_a_later_line_of_gh_stderr_still_goes_on_its_file() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let (run, gh, setup) = uncommented(repo.path(), out.path());
    std::fs::write(gh.join("no-lines-late"), "").unwrap();
    let s = publish::comment(&run, None, &setup).unwrap();
    let pr = &s["prComments"];
    assert_eq!(
        (&pr["posted"], &pr["toFile"], &pr["failed"]),
        (&json!(1), &json!(1), &json!(0)),
        "{pr}"
    );
    assert_eq!(posted(&gh)[0]["subject_type"], json!("file"));
}

#[test]
fn a_pr_head_that_moved_elsewhere_is_posted_to_on_the_reviewed_commit() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let (run, gh, setup) = uncommented(repo.path(), out.path());
    let reviewed = head(repo.path());
    std::fs::write(repo.path().join("src/other.rs"), "pub fn o() {}\n").unwrap();
    common::git(repo.path(), &["add", "."]);
    common::git(repo.path(), &["commit", "-qm", "feat: another file"]);
    std::fs::write(gh.join("head"), head(repo.path())).unwrap();
    let s = publish::comment(&run, None, &setup).unwrap();
    let pr = &s["prComments"];
    assert_eq!(pr["posted"], json!(1));
    let reason = pr["reason"].as_str().unwrap();
    assert!(reason.contains("the PR's head moved to"), "{reason}");
    assert!(
        reason.contains("change none of the defects' lines"),
        "{reason}"
    );
    assert_eq!(posted(&gh)[0]["commit_id"], json!(reviewed));
    assert_eq!(s["head"], json!(reviewed));
}

#[test]
fn a_pr_head_that_rewrote_a_defects_line_is_refused_and_nothing_kept() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let (run, gh, setup) = uncommented(repo.path(), out.path());
    std::fs::write(repo.path().join("src/lib.rs"), "pub fn f() -> u8 { 2 }\n").unwrap();
    common::git(repo.path(), &["commit", "-qam", "fix: f"]);
    std::fs::write(gh.join("head"), head(repo.path())).unwrap();
    let e = publish::comment(&run, None, &setup)
        .unwrap_err()
        .to_string();
    assert!(
        e.starts_with("nothing was posted: the PR's head moved to"),
        "{e}"
    );
    assert!(
        e.contains("change the lines of 1 defect(s): `src/lib.rs:1` f returns the wrong value"),
        "{e}"
    );
    assert!(posted(&gh).is_empty());
    assert_eq!(
        state(&run)["publish"].get("asked"),
        None,
        "the run is left as it was"
    );
}

#[test]
fn a_pr_head_that_does_not_hold_the_reviewed_one_is_refused() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let (run, gh, setup) = uncommented(repo.path(), out.path());
    common::git(
        repo.path(),
        &["commit", "-q", "--amend", "-m", "feat: rewritten"],
    );
    std::fs::write(gh.join("head"), head(repo.path())).unwrap();
    let e = publish::comment(&run, None, &setup)
        .unwrap_err()
        .to_string();
    assert!(e.contains("does not hold the reviewed head"), "{e}");
    assert!(posted(&gh).is_empty());
}

#[test]
fn an_unfinished_run_is_refused() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let gh = out.path().join("gh");
    let setup = stand_in(&gh, &head(repo.path()));
    let run = out.path().join("open");
    step::start(&step::StartOptions {
        run_dir: run.clone(),
        fresh: true,
        ..common::opts(repo.path(), out.path())
    })
    .unwrap();
    let e = publish::comment(&run, None, &setup)
        .unwrap_err()
        .to_string();
    assert!(e.contains("has not finished: resume it first"), "{e}");
    assert!(!gh.join("calls").exists());
}

#[test]
fn a_run_reviewed_on_a_detached_head_is_published_only_to_a_pr_named() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    common::git(repo.path(), &["checkout", "-q", "--detach"]);
    let (run, gh, setup) = uncommented(repo.path(), out.path());
    common::git(repo.path(), &["checkout", "-q", "main"]);
    let e = publish::comment(&run, None, &setup)
        .unwrap_err()
        .to_string();
    assert!(e.contains("was reviewed on a detached HEAD"), "{e}");
    assert!(e.contains("--pr <number>"), "{e}");
    assert!(
        !gh.join("calls").exists(),
        "gh is not asked for the checked-out branch's PR"
    );
    let s = publish::comment(&run, Some(7), &setup).unwrap();
    assert_eq!(s["prComments"]["posted"], json!(1));
    let calls = std::fs::read_to_string(gh.join("calls")).unwrap();
    assert!(calls.starts_with("pr view 7 --json"), "{calls}");
}
