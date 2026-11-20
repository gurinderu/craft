//! When the graph's index cannot serve a review: made of a commit that does not hold the base —
//! told by where the root's HEAD was when the index was made, not by the base's own commit time —
//! made before any move the root's HEAD history keeps, or naming no time.

use std::path::Path;
use std::process::Command;

use super::{diff_of, fixture};
use crate::consumers::cbm::Index;
use crate::consumers::fresh::{self, Stale};

/// `git args` in `dir`, its committer (and so its reflog entry) dated `at` seconds.
fn git_at(dir: &Path, at: u64, args: &[&str]) -> String {
    let date = format!("@{at} +0000");
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .env("GIT_AUTHOR_DATE", &date)
        .env("GIT_COMMITTER_DATE", &date)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {out:?}");
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

fn index(root: &Path, at: &str) -> Index {
    Index {
        at: at.into(),
        root: root.display().to_string(),
        ..Index::default()
    }
}

/// A root whose HEAD is at A from second 1000, and moves at second 3000 to B, a commit made
/// earlier (second 500) elsewhere and pulled in: B's commit time is before an index made at 2000,
/// which was made of A all the same. Its commits: (A, B).
fn pulled_late(t: &Path) -> (std::path::PathBuf, String, String) {
    let repo = t.join("root");
    std::fs::create_dir_all(&repo).unwrap();
    git_at(&repo, 1000, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("a.rs"), "fn a() {}\n").unwrap();
    git_at(&repo, 1000, &["add", "."]);
    git_at(&repo, 1000, &["commit", "-qm", "A"]);
    let a = git_at(&repo, 1000, &["rev-parse", "HEAD"]);
    let tree = git_at(&repo, 500, &["rev-parse", "HEAD^{tree}"]);
    let b = git_at(&repo, 500, &["commit-tree", &tree, "-p", &a, "-m", "B"]);
    git_at(&repo, 3000, &["merge", "-q", "--ff-only", &b]);
    (repo, a, b)
}

#[test]
fn an_index_made_before_the_base_came_in_is_stale_though_the_base_is_older() {
    let t = tempfile::tempdir().unwrap();
    let (root, _, b) = pulled_late(t.path());
    // Made at 2000 (1970-01-01T00:33:20Z), of A: B, though committed at 500, came in at 3000.
    let why = fresh::stale(&b, "p", &index(&root, "1970-01-01T00:33:20Z")).unwrap_err();
    assert!(matches!(*why, Stale::Older { .. }), "{why}");
    let said = why.to_string();
    assert!(said.contains("does not hold the base"), "{said}");
    assert!(said.contains("cli index_repository"), "{said}");
    // Made at 4000, of B: it holds the base.
    fresh::stale(&b, "p", &index(&root, "1970-01-01T01:06:40Z")).unwrap();
}

#[test]
fn an_index_older_than_every_kept_move_or_naming_no_time_is_stale() {
    let t = tempfile::tempdir().unwrap();
    let (root, a, _) = pulled_late(t.path());
    let why = fresh::stale(&a, "p", &index(&root, "1970-01-01T00:00:10Z")).unwrap_err();
    assert!(matches!(*why, Stale::Unknown { .. }), "{why}");
    let why = fresh::stale(&a, "p", &index(&root, "yesterday")).unwrap_err();
    assert!(matches!(*why, Stale::NoTime { .. }), "{why}");
    assert!(why.to_string().contains("names no time it was made"));
}

#[test]
fn a_base_outside_the_indexed_root_s_history_is_stale() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let base = diff_of(&repo).merge_base;
    let other = fixture(&t.path().join("other"), "// another history\n");
    let later = "2099-01-01T00:00:00Z";
    fresh::stale(&base, "p", &index(&repo, later)).unwrap();
    let why = fresh::stale(&base, "p", &index(&other, later)).unwrap_err();
    assert!(matches!(*why, Stale::Older { .. }), "{why}");
    let hint = format!(r#""repo_path":"{}""#, other.display());
    assert!(why.to_string().contains(&hint), "{why}");
    let gone = fresh::stale(&base, "p", &index(&t.path().join("none"), later)).unwrap_err();
    assert!(matches!(*gone, Stale::History { .. }), "{gone}");
}
