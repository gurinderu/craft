//! A delta round needs an earlier review behind its base: `delta` over a base where the branch
//! leaves origin's default branch — given, or the default — would review the whole branch and cap
//! its verdict at Warning, so the start refuses it before any task is handed out; a base after
//! that point, an earlier review's head, starts as before.
#![expect(
    clippy::unwrap_used,
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
