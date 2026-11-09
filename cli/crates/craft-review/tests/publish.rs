//! Publishing on the PR (`comment`): a finished run posts its defects through `gh` — here a stand-in
//! on the PATH that keeps what it is asked to post, never a real PR — lists the doubtful findings
//! for the reviewer, posts nothing a second time over the same head, names a gh failure without
//! touching the verdict, and posts nothing unasked.

mod common;

use std::time::Duration;

use common::fixture;
use common::post::{errors, finished, found, head, posted, report, stand_in};
use craft_review::publish::PostSetup;
use serde_json::{Value, json};

#[test]
fn a_finished_run_posts_its_defects_and_lists_the_doubtful_for_the_reviewer() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let gh = out.path().join("gh");
    let setup = stand_in(&gh, &head(repo.path()));
    let s = finished(repo.path(), out.path(), "run", true, &setup, &found());
    assert_eq!(s["verdict"], json!("Block"));
    let sorting = &s["sorting"];
    assert_eq!(
        (
            &sorting["defect"],
            &sorting["doubtful"],
            &sorting["inDiffJudged"]
        ),
        (&json!(1), &json!(1), &json!(true))
    );
    let d = &sorting["findings"][0];
    assert_eq!(
        (&d["n"], &d["line"], &d["title"], &d["outsideDiff"]),
        (
            &json!(1),
            &json!(40),
            &json!("g leaks a handle"),
            &json!(true)
        )
    );
    assert_eq!(s["memoryContradictions"]["count"], json!(0));
    let pr = &s["prComments"];
    assert_eq!(
        (
            &pr["pr"],
            &pr["requested"],
            &pr["posted"],
            &pr["already"],
            &pr["error"]
        ),
        (&json!(7), &json!(1), &json!(1), &json!(0), &json!(""))
    );
    let sent = posted(&gh);
    assert_eq!(sent.len(), 1);
    let req = &sent[0];
    assert_eq!(
        (&req["commit_id"], &req["path"], &req["line"], &req["side"]),
        (
            &json!(head(repo.path())),
            &json!("src/lib.rs"),
            &json!(1),
            &json!("RIGHT")
        )
    );
    let body = req["body"].as_str().unwrap();
    assert!(
        body.starts_with(
            "[High] f returns the wrong value\n\nwrong — fix it\n\n<!-- craft-lens: errors -->\n"
        ),
        "{body}"
    );
    assert!(body.ends_with("<!-- craft-finding -->"), "{body}");
    common::assert_contains_all(
        &report(&s),
        &[
            "## Doubtful — for the reviewer, not posted",
            "1. High · `src/lib.rs:40` · g leaks a handle · doubtful: its line is outside the lines the diff changed",
            "## PR comments\n- posted 1 of 1 defect(s) · 0 already on the PR",
            "PR #7 https://github.com/o/r/pull/7",
        ],
    );
}

#[test]
fn a_second_run_over_the_same_head_posts_nothing_again() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let gh = out.path().join("gh");
    let setup = stand_in(&gh, &head(repo.path()));
    finished(repo.path(), out.path(), "first", true, &setup, &found());
    let s = finished(repo.path(), out.path(), "second", true, &setup, &found());
    let pr = &s["prComments"];
    assert_eq!(
        (&pr["requested"], &pr["posted"], &pr["already"]),
        (&json!(1), &json!(0), &json!(1))
    );
    assert_eq!(posted(&gh).len(), 1, "one comment on the PR after two runs");
    assert!(report(&s).contains(
        "posted 0 of 1 defect(s) · 1 already on the PR (craft-finding marker), not posted again"
    ));
}

#[test]
fn two_defects_sharing_a_title_on_one_file_are_both_posted_once() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let lines: String = (1..=50).map(|n| format!("pub fn f{n}() {{}}\n")).collect();
    std::fs::write(repo.path().join("src/lib.rs"), lines).unwrap();
    common::git(repo.path(), &["commit", "-qam", "feat: fifty functions"]);
    let gh = out.path().join("gh");
    let setup = stand_in(&gh, &head(repo.path()));
    let same = vec![errors(12, "unchecked index"), errors(40, "unchecked index")];
    let s = finished(repo.path(), out.path(), "first", true, &setup, &same);
    let pr = &s["prComments"];
    assert_eq!(
        (&pr["requested"], &pr["posted"], &pr["already"]),
        (&json!(2), &json!(2), &json!(0))
    );
    let at: Vec<Value> = posted(&gh).iter().map(|r| r["line"].clone()).collect();
    assert_eq!(at, [json!(12), json!(40)]);
    let s = finished(repo.path(), out.path(), "second", true, &setup, &same);
    let pr = &s["prComments"];
    assert_eq!((&pr["posted"], &pr["already"]), (&json!(0), &json!(2)));
    assert_eq!(posted(&gh).len(), 2, "neither is posted again");
}

#[test]
fn a_gh_failure_is_named_and_the_verdict_stands() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let gh = out.path().join("gh");
    let setup = stand_in(&gh, &head(repo.path()));
    std::fs::write(gh.join("fail"), "").unwrap();
    let s = finished(repo.path(), out.path(), "run", true, &setup, &found());
    assert_eq!(s["verdict"], json!("Block"));
    assert_eq!(
        s["notRun"],
        json!([]),
        "a failed post is no gap in the review"
    );
    let pr = &s["prComments"];
    assert_eq!((&pr["posted"], &pr["failed"]), (&json!(0), &json!(0)));
    let error = pr["error"].as_str().unwrap();
    assert!(
        error.contains("gh pr view failed: HTTP 401: Bad credentials"),
        "{error}"
    );
    assert!(
        report(&s).contains("- ⚠️ nothing was posted (1 defect(s)): gh pr view failed: HTTP 401")
    );
    assert!(posted(&gh).is_empty());
}

#[test]
fn a_missing_gh_and_a_pr_at_another_head_are_named() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let empty = out.path().join("no-gh");
    std::fs::create_dir_all(&empty).unwrap();
    let missing = PostSetup {
        budget: Duration::from_secs(30),
        path: Some(empty.into_os_string()),
    };
    let s = finished(repo.path(), out.path(), "a", true, &missing, &found());
    assert_eq!(
        s["prComments"]["error"],
        json!("gh is not installed (no `gh` on the PATH)")
    );
    let gh = out.path().join("gh");
    let setup = stand_in(&gh, "0123456789abcdef0123456789abcdef01234567");
    let s = finished(repo.path(), out.path(), "b", true, &setup, &found());
    let reason = s["prComments"]["reason"].as_str().unwrap();
    assert!(
        reason.starts_with("the PR's head 0123456789ab is not the reviewed head"),
        "{reason}"
    );
    assert!(posted(&gh).is_empty());
}

#[test]
fn without_comment_nothing_is_sorted_or_posted() {
    let (repo, out) = (fixture(true), tempfile::tempdir().unwrap());
    let gh = out.path().join("gh");
    let setup = stand_in(&gh, &head(repo.path()));
    let s = finished(repo.path(), out.path(), "run", false, &setup, &found());
    assert_eq!(
        (&s["sorting"], &s["prComments"]),
        (&Value::Null, &Value::Null)
    );
    assert_eq!(s["memoryContradictions"]["count"], json!(0));
    assert!(!gh.join("calls").exists(), "gh was never called");
    let r = report(&s);
    assert!(
        !r.contains("## Doubtful") && !r.contains("## PR comments"),
        "{r}"
    );
}
