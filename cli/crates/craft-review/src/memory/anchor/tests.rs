use std::path::Path;
use std::process::Command;

use super::super::priors::scope_check;
use super::{Anchor, calendar_date};
use crate::memory::PriorDecision;

fn record(id: &str, scope: &str, commit: &str, when: &str) -> PriorDecision {
    PriorDecision {
        id: id.into(),
        scope: scope.into(),
        commit: commit.into(),
        when: when.into(),
        ..PriorDecision::default()
    }
}

#[test]
fn a_calendar_date_is_read_from_the_start_of_when_and_nothing_else_is() {
    for (when, day) in [
        ("2026-05-01", Some("2026-05-01")),
        ("2026-05-01T10:00:00Z", Some("2026-05-01")),
        ("2026-05-01 by nick", Some("2026-05-01")),
        ("2024-02-29", Some("2024-02-29")),
        ("2000-02-29", Some("2000-02-29")),
        ("1900-02-29", None),
        ("2026-02-29", None),
        ("2026-00-10", None),
        ("2026-13-01", None),
        ("2026-05-00", None),
        ("2026-05-011", None),
        ("2026/05/01", None),
        ("2026-05/01", None),
        ("+026-05-01", None),
        ("2026-5-011x", None),
        ("June 2026", None),
        ("26-05-01", None),
        ("", None),
    ] {
        assert_eq!(calendar_date(when), day, "{when:?}");
    }
}

#[test]
fn every_month_ends_on_its_own_last_day() {
    let last = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for (m, days) in (1..=12).zip(last) {
        let day = format!("2026-{m:02}-{days:02}");
        assert_eq!(calendar_date(&day), Some(day.as_str()));
        let past = format!("2026-{m:02}-{:02}", days + 1);
        assert_eq!(calendar_date(&past), None, "{past}");
    }
}

#[test]
fn the_commit_anchors_a_record_before_its_date_and_neither_leaves_it_unanchored() {
    let both = record("a", "src", "abc1234", "2026-05-01");
    assert_eq!(both.anchor(), Some(Anchor::Commit("abc1234")));
    let dated = record("b", "src", "", "2026-05-01");
    assert_eq!(dated.anchor(), Some(Anchor::Date("2026-05-01")));
    assert_eq!(record("c", "src", "", "last week").anchor(), None);
    assert_eq!(record("d", "src", "", "").anchor(), None);
}

#[test]
fn a_date_anchor_names_the_date_where_a_commit_anchor_names_the_commit() {
    assert_eq!(Anchor::Commit("abc1234").since(), "abc1234");
    assert_eq!(
        Anchor::Date("2026-05-01").since(),
        "the decision date 2026-05-01"
    );
    assert_eq!(
        Anchor::Commit("abc1234").missing(),
        "commit abc1234 not found in this repo — raised normally"
    );
    assert_eq!(
        Anchor::Date("2026-05-01").missing(),
        "no commit in this repo before the decision date 2026-05-01 — raised normally"
    );
}

fn commit_at(dir: &Path, file: &str, text: &str, date: &str) -> String {
    std::fs::write(dir.join(file), text).unwrap();
    let run = |args: &[&str]| {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .env("GIT_AUTHOR_DATE", date)
            .env("GIT_COMMITTER_DATE", date)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}");
        String::from_utf8(out.stdout).unwrap().trim().to_owned()
    };
    run(&["add", "."]);
    run(&["commit", "-qm", file]);
    run(&["rev-parse", "HEAD"])
}

#[test]
fn a_dated_record_is_checked_against_the_last_commit_before_its_day_in_utc() {
    let t = tempfile::tempdir().unwrap();
    let d = t.path();
    crate::git::tests::git(d, &["init", "-q", "-b", "main"]);
    std::fs::create_dir_all(d.join("src")).unwrap();
    std::fs::write(d.join("src/a.rs"), "a\n").unwrap();
    let first = commit_at(d, "src/b.rs", "b\n", "2026-05-01T12:00:00+0000");
    // 2026-05-02 01:30 UTC: after the start of the 2nd in UTC, though the 1st where it was made.
    commit_at(d, "src/b.rs", "b2\n", "2026-05-01T23:30:00-0200");
    let ds = [
        record("a-2nd", "src/a.rs", "", "2026-05-02"),
        record("b-2nd", "src/b.rs", "", "2026-05-02"),
        record("a-1st", "src/a.rs", "", "2026-05-01"),
        record("b-3rd", "src/b.rs", "", "2026-05-03"),
        record("by-commit", "src/a.rs", &first, ""),
        record("unknown", "src/a.rs", "deadbeef", "2026-05-03"),
        record("unanchored", "src/a.rs", "", "soon"),
    ];
    let refs: Vec<&PriorDecision> = ds.iter().collect();
    let s = scope_check(d, &refs);
    let ids = |set: &std::collections::BTreeSet<String>| set.iter().cloned().collect::<Vec<_>>();
    assert_eq!(ids(&s.unchanged), ["a-2nd", "b-3rd", "by-commit"]);
    assert_eq!(ids(&s.missing), ["a-1st", "unanchored", "unknown"]);
    // The working tree counts as a change since the day, as it does since a commit.
    std::fs::write(d.join("src/b.rs"), "b3\n").unwrap();
    let s = scope_check(d, &refs);
    assert_eq!(ids(&s.unchanged), ["a-2nd", "by-commit"]);
}

fn anchored(id: &str, scope: &str, when: &str) -> PriorDecision {
    PriorDecision {
        title: format!("defect {id}"),
        reason: "r".into(),
        line: 10,
        lens: "errors".into(),
        ..record(id, scope, "", when)
    }
}

fn finding(id: &str, file: &str, severity: &str) -> serde_json::Value {
    serde_json::json!({"severity": severity, "title": format!("defect {id}"), "file": file, "line": 10, "why": "w", "source": "errors", "tier": "confirmed"})
}

#[test]
fn only_a_record_with_a_commit_or_a_date_that_could_set_its_finding_aside_is_checked() {
    let ds = [
        anchored("vague", "src/a.rs", "soon"),
        anchored("critical", "src/b.rs", "2026-05-01"),
        anchored("dated", "src/c.rs", "2026-05-02"),
    ];
    let findings = [
        finding("vague", "src/a.rs", "Medium"),
        finding("critical", "src/b.rs", "Critical"),
        finding("dated", "src/c.rs", "Medium"),
    ];
    let handed = std::cell::RefCell::new(Vec::new());
    let check = |ds: &[&PriorDecision]| {
        handed.borrow_mut().extend(ds.iter().map(|d| d.id.clone()));
        crate::memory::Scope::default()
    };
    crate::memory::apply::prepare(&findings, &ds, &check, &[]);
    assert_eq!(*handed.borrow(), ["dated"]);
}

#[test]
fn a_date_no_commit_precedes_is_named_once_however_many_findings_it_answers() {
    let ds = [anchored("dated", "src/c.rs", "2026-05-02")];
    let findings = vec![
        finding("dated", "src/c.rs", "Medium"),
        finding("dated", "src/c.rs", "Low"),
    ];
    let check = |ds: &[&PriorDecision]| crate::memory::Scope {
        missing: ds.iter().map(|d| d.id.clone()).collect(),
        ..crate::memory::Scope::default()
    };
    let prepared = crate::memory::apply::prepare(&findings, &ds, &check, &[]);
    let out = crate::memory::apply::apply(findings, &prepared, None, "why");
    let named: Vec<&String> = out
        .refused
        .iter()
        .filter(|r| r.starts_with("decision dated"))
        .collect();
    assert_eq!(
        named,
        [
            "decision dated: no commit in this repo before the decision date 2026-05-02 — raised normally"
        ]
    );
    assert_eq!(out.reraised, 2);
}
