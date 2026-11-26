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
