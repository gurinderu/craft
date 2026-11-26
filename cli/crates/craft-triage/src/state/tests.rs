//! The scopes git observes for a run's records: each record checked once, its answer kept.

use std::path::Path;
use std::process::Command;

use craft_review::memory::{PriorDecision, RecordKind};

use super::Seen;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "user.email=a@b", "-c", "user.name=a"])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}");
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

/// A repository with `src/a.rs` committed once, and that commit.
fn repo() -> (tempfile::TempDir, String) {
    let d = tempfile::tempdir().unwrap();
    git(d.path(), &["init", "-q"]);
    std::fs::create_dir(d.path().join("src")).unwrap();
    std::fs::write(d.path().join("src/a.rs"), "fn a() {}\n").unwrap();
    git(d.path(), &["add", "."]);
    git(d.path(), &["commit", "-qm", "a"]);
    let head = git(d.path(), &["rev-parse", "HEAD"]);
    (d, head)
}

fn record(id: &str, commit: &str) -> PriorDecision {
    PriorDecision {
        id: id.into(),
        kind: RecordKind::Decision,
        scope: "src/a.rs".into(),
        commit: commit.into(),
        ..PriorDecision::default()
    }
}

#[test]
fn a_record_whose_scope_is_untouched_is_unchanged_and_one_whose_commit_is_unknown_is_missing() {
    let (d, head) = repo();
    let (kept, gone) = (
        record("decision-a", &head),
        record("decision-b", &"0".repeat(40)),
    );
    let mut seen = Seen::default();
    let s = seen.scope(d.path(), &[&kept, &gone]);
    assert_eq!(s.unchanged.into_iter().collect::<Vec<_>>(), ["decision-a"]);
    assert_eq!(s.missing.into_iter().collect::<Vec<_>>(), ["decision-b"]);
}

#[test]
fn a_record_checked_once_keeps_its_answer_though_its_code_changes_after() {
    let (d, head) = repo();
    let kept = record("decision-a", &head);
    let mut seen = Seen::default();
    assert!(
        seen.scope(d.path(), &[&kept])
            .unchanged
            .contains("decision-a")
    );
    std::fs::write(d.path().join("src/a.rs"), "fn a() { b() }\n").unwrap();
    assert!(
        seen.scope(d.path(), &[&kept])
            .unchanged
            .contains("decision-a"),
        "a later step reads what the first observed"
    );
    let mut fresh = Seen::default();
    assert!(
        !fresh
            .scope(d.path(), &[&kept])
            .unchanged
            .contains("decision-a")
    );
}

#[test]
fn only_the_records_asked_about_are_answered() {
    let (d, head) = repo();
    let (a, b) = (record("decision-a", &head), record("decision-c", &head));
    let mut seen = Seen::default();
    seen.scope(d.path(), &[&a, &b]);
    let s = seen.scope(d.path(), &[&a]);
    assert_eq!(s.unchanged.into_iter().collect::<Vec<_>>(), ["decision-a"]);
}

#[test]
fn why_a_dated_record_is_missing_is_kept_for_it_and_handed_only_with_it() {
    let (d, head) = repo();
    let dated = PriorDecision {
        when: "2026-05-02".into(),
        ..record("decision-d", "")
    };
    let kept = record("decision-a", &head);
    let mut seen = Seen::default();
    let s = seen.scope(d.path(), &[&dated, &kept]);
    let why = s.why_missing.get("decision-d").cloned().unwrap_or_default();
    assert!(why.starts_with("no trunk could be resolved"), "{why}");
    let again = seen.scope(d.path(), &[&dated]);
    assert_eq!(again.why_missing.get("decision-d"), Some(&why));
    assert!(seen.scope(d.path(), &[&kept]).why_missing.is_empty());
}

#[test]
fn the_pull_request_whose_merge_a_record_was_checked_since_is_kept_for_it_and_handed_only_with_it()
{
    let d = tempfile::tempdir().unwrap();
    git(d.path(), &["init", "-q"]);
    git(
        d.path(),
        &["remote", "add", "origin", "git@github.com:o/r.git"],
    );
    std::fs::create_dir(d.path().join("src")).unwrap();
    std::fs::write(d.path().join("src/a.rs"), "fn a() {}\n").unwrap();
    git(d.path(), &["add", "."]);
    git(d.path(), &["commit", "-qm", "feat: a (#3)"]);
    git(
        d.path(),
        &["update-ref", "refs/remotes/origin/main", "HEAD"],
    );
    let linked = PriorDecision {
        pulls: vec![craft_review::memory::Pull {
            repo: "o/r".into(),
            number: 3,
        }],
        ..record("decision-p", "")
    };
    let other = record("decision-a", &git(d.path(), &["rev-parse", "HEAD"]));
    let mut seen = Seen::default();
    let s = seen.scope(d.path(), &[&linked, &other]);
    assert_eq!(s.merged.get("decision-p"), Some(&3));
    assert!(s.unchanged.contains("decision-p"));
    let state = serde_json::to_value(&seen).unwrap();
    assert_eq!(state["merged"], serde_json::json!({"decision-p": 3}));
    let mut back: Seen = serde_json::from_value(state).unwrap();
    assert_eq!(
        back.scope(d.path(), &[&linked]).merged.get("decision-p"),
        Some(&3)
    );
    assert!(back.scope(d.path(), &[&other]).merged.is_empty());
    let none = serde_json::to_value(Seen::default()).unwrap();
    assert!(none.get("merged").is_none(), "{none}");
}

#[test]
fn a_record_whose_scope_the_trunk_changed_between_its_date_and_its_merge_is_kept_apart() {
    let d = tempfile::tempdir().unwrap();
    let at = |date: &str, args: &[&str]| {
        let out = Command::new("git")
            .args(["-c", "user.email=a@b", "-c", "user.name=a"])
            .args(args)
            .current_dir(d.path())
            .env("GIT_AUTHOR_DATE", date)
            .env("GIT_COMMITTER_DATE", date)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}");
    };
    let write = |text: &str| std::fs::write(d.path().join("src/a.rs"), text).unwrap();
    at("2026-05-01T08:00:00+0000", &["init", "-q"]);
    at(
        "2026-05-01T08:00:00+0000",
        &["remote", "add", "origin", "git@github.com:o/r.git"],
    );
    std::fs::create_dir(d.path().join("src")).unwrap();
    for (text, date, subject) in [
        ("0\n", "2026-05-01T08:00:00+0000", "root"),
        ("4\n", "2026-05-02T09:00:00+0000", "fix: a (#4)"),
    ] {
        write(text);
        at(date, &["add", "."]);
        at(date, &["commit", "-qm", subject]);
    }
    std::fs::write(d.path().join("src/b.rs"), "b\n").unwrap();
    at("2026-05-02T10:00:00+0000", &["add", "."]);
    at(
        "2026-05-02T10:00:00+0000",
        &["commit", "-qm", "feat: b (#3)"],
    );
    at(
        "2026-05-02T10:00:00+0000",
        &["update-ref", "refs/remotes/origin/main", "HEAD"],
    );
    let linked = PriorDecision {
        pulls: vec![craft_review::memory::Pull {
            repo: "o/r".into(),
            number: 3,
        }],
        when: "2026-05-02".into(),
        ..record("decision-p", "")
    };
    let mut seen = Seen::default();
    let s = seen.scope(d.path(), &[&linked]);
    assert!(s.between.contains("decision-p"), "{s:?}");
    assert!(s.unchanged.is_empty());
    let state = serde_json::to_value(&seen).unwrap();
    assert_eq!(state["between"], serde_json::json!(["decision-p"]));
    let mut back: Seen = serde_json::from_value(state).unwrap();
    assert!(
        back.scope(d.path(), &[&linked])
            .between
            .contains("decision-p")
    );
    let other = record("decision-a", "");
    assert!(back.scope(d.path(), &[&other]).between.is_empty());
    let none = serde_json::to_value(Seen::default()).unwrap();
    assert!(none.get("between").is_none(), "{none}");
}
