//! A delta round needs an earlier review behind its base: `delta` over a base where the branch
//! leaves origin's default branch — given, or the default — would review the whole branch and cap
//! its verdict at Warning, so the start refuses it before any task is handed out, as it does a
//! base older than that point; a base after that point, an earlier review's head, starts as
//! before, as does a round with no base whose chain holds an earlier round, which reviews the fix
//! commits since that round's head.
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the helpers of these tests fail loudly, like the tests they serve"
)]

mod common;

use std::path::Path;

use common::{fixture, git, ids};
use craft_review::step::{self, StartOptions};

fn head(repo: &Path) -> String {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["rev-parse", "HEAD"])
        .output()
        .unwrap();
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

/// A start of `repo` with `delta` over `base`, its run in `out/run`.
fn delta_over(repo: &Path, out: &Path, base: Option<String>) -> StartOptions {
    StartOptions {
        base,
        delta: true,
        ..common::opts(repo, out)
    }
}

/// The refusal's text, and that the run holds no state and no tasks.
fn refused(opts: &StartOptions) -> String {
    let err = step::start(opts).unwrap_err();
    assert!(err.refuses_argument(), "{err}");
    assert!(!opts.run_dir.join("state.json").exists());
    assert!(!opts.run_dir.join("tasks").exists());
    err.to_string()
}

#[test]
fn delta_over_the_branch_point_is_refused_given_or_by_default() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let point = {
        let o = std::process::Command::new("git")
            .arg("-C")
            .arg(repo.path())
            .args(["rev-parse", "origin/main"])
            .output()
            .unwrap();
        String::from_utf8(o.stdout).unwrap().trim().to_owned()
    };
    for base in [None, Some("origin/main".to_owned()), Some(point.clone())] {
        let why = refused(&delta_over(repo.path(), out.path(), base));
        assert!(why.contains("--delta"), "{why}");
        assert!(
            why.contains(point.get(..12).unwrap()),
            "the branch point is named: {why}"
        );
        assert!(why.contains("earlier review"), "{why}");
    }
}

#[test]
fn delta_over_an_earlier_reviews_head_starts() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let reviewed = head(repo.path());
    std::fs::write(repo.path().join("src/lib.rs"), "pub fn f() -> u8 { 0 }\n").unwrap();
    git(repo.path(), &["commit", "-qam", "fix: f returns 0"]);
    for fresh in [false, true] {
        let run = out.path().join(format!("fresh-{fresh}"));
        let s = step::start(&StartOptions {
            fresh,
            ..delta_over(repo.path(), &run, Some(reviewed.clone()))
        })
        .unwrap();
        assert_eq!(ids(&s), ["scout-rust"], "{s}");
    }
}

#[test]
fn a_full_round_over_the_branch_point_starts() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let s = step::start(&StartOptions {
        delta: false,
        ..delta_over(repo.path(), out.path(), None)
    })
    .unwrap();
    assert_eq!(ids(&s), ["scout-rust"], "{s}");
}

#[test]
fn delta_over_a_base_older_than_the_branch_point_is_refused() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    // The branch leaves trunk at its first commit; `origin/main~1` is older than that point, as a
    // stale local main or the reviewed head of a branch rebased since would be.
    git(
        repo.path(),
        &["update-ref", "refs/remotes/origin/main", "HEAD"],
    );
    std::fs::write(repo.path().join("src/lib.rs"), "pub fn f() -> u8 { 0 }\n").unwrap();
    git(repo.path(), &["commit", "-qam", "fix: f returns 0"]);
    for base in ["origin/main~1", "HEAD~2"] {
        let why = refused(&delta_over(repo.path(), out.path(), Some(base.to_owned())));
        assert!(why.contains("earlier review"), "{base}: {why}");
    }
}

/// Answers every task of a run until it is done: a small plan, lenses that find nothing.
fn drive(run: &Path, mut s: serde_json::Value) {
    while s["done"] == serde_json::json!(false) {
        let mut answers = serde_json::Map::new();
        for id in ids(&s) {
            let a = if id.starts_with("scout-") {
                common::scout("small", &["errors"])
            } else {
                let name = id.strip_prefix("lens-rust-").unwrap().split('-').next();
                common::lens(name.unwrap(), &[])
            };
            answers.insert(id, a);
        }
        s = common::submit(run, serde_json::Value::Object(answers));
    }
}

#[test]
fn delta_with_no_base_starts_over_the_fixes_since_an_earlier_round_in_the_chain() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let first = out.path().join("r1");
    let s = step::start(&StartOptions {
        run_dir: first.clone(),
        ..common::opts(repo.path(), out.path())
    })
    .unwrap();
    drive(&first, s);
    std::fs::write(repo.path().join("src/lib.rs"), "pub fn f() -> u8 { 0 }\n").unwrap();
    git(repo.path(), &["commit", "-qam", "fix: f returns 0"]);
    let s = step::start(&delta_over(repo.path(), out.path(), None)).unwrap();
    assert_eq!(
        ids(&s).first().map(String::as_str),
        Some("scout-rust"),
        "{s}"
    );
    let state = std::fs::read_to_string(out.path().join("run/state.json")).unwrap();
    let state: serde_json::Value = serde_json::from_str(&state).unwrap();
    assert_eq!(state["context"]["reReview"], "fixes", "{state}");
}
