use super::{Anchor, Unusable, calendar_date};
use crate::memory::PriorDecision;

mod repo;

pub(super) fn record(id: &str, scope: &str, commit: &str, when: &str) -> PriorDecision {
    PriorDecision {
        id: id.into(),
        scope: scope.into(),
        commit: commit.into(),
        when: when.into(),
        ..PriorDecision::default()
    }
}

#[test]
fn a_calendar_date_is_the_utc_day_when_names_and_nothing_else_is() {
    for (when, day) in [
        ("2026-05-01", Some("2026-05-01")),
        ("2026-05-01T10:00:00Z", Some("2026-05-01")),
        ("2026-05-01T10:00:00", Some("2026-05-01")),
        // A zone moves the moment to its UTC day, either way.
        ("2026-05-01T23:30:00-02:00", Some("2026-05-02")),
        ("2026-05-02T01:00:00+05:00", Some("2026-05-01")),
        ("2026-12-31T23:00:00-01:30", Some("2027-01-01")),
        ("2026-05-01 by nick", Some("2026-05-01")),
        ("2024-02-29", Some("2024-02-29")),
        ("2000-02-29", Some("2000-02-29")),
        ("1900-02-29", None),
        ("2026-02-29", None),
        ("2026-00-10", None),
        ("2026-13-01", None),
        ("2026-05-00", None),
        ("2026-05-011", None),
        ("2026-05-01T25:00:00Z", None),
        ("2026-05-01T10:00:00+25:00", None),
        ("2026-05-01T10:00:00Z by nick", None),
        ("2026/05/01", None),
        ("2026-05/01", None),
        ("+026-05-01", None),
        ("2026-5-011x", None),
        ("June 2026", None),
        ("26-05-01", None),
        ("", None),
    ] {
        assert_eq!(calendar_date(when).as_deref(), day, "{when:?}");
    }
}

#[test]
fn every_month_ends_on_its_own_last_day() {
    let last = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for (m, days) in (1..=12).zip(last) {
        let day = format!("2026-{m:02}-{days:02}");
        assert_eq!(calendar_date(&day), Some(day.clone()));
        let past = format!("2026-{m:02}-{:02}", days + 1);
        assert_eq!(calendar_date(&past), None, "{past}");
    }
}

#[test]
fn the_commit_anchors_a_record_before_its_date_and_neither_leaves_it_unanchored() {
    let both = record("a", "src", "abc1234", "2026-05-01");
    assert_eq!(both.anchor(), Some(Anchor::Commit("abc1234")));
    let dated = record("b", "src", "", "2026-05-01");
    assert_eq!(dated.anchor(), Some(Anchor::Date("2026-05-01".into())));
    let zoned = record("z", "src", "", "2026-05-01T23:30:00-02:00");
    assert_eq!(zoned.anchor(), Some(Anchor::Date("2026-05-02".into())));
    assert_eq!(record("c", "src", "", "last week").anchor(), None);
    assert_eq!(record("d", "src", "", "").anchor(), None);
}

#[test]
fn a_date_anchor_names_the_date_where_a_commit_anchor_names_the_commit() {
    let day = Anchor::Date("2026-05-01".into());
    assert_eq!(Anchor::Commit("abc1234").since(), "abc1234");
    assert_eq!(day.since(), "the decision date 2026-05-01");
    assert_eq!(
        Anchor::Commit("abc1234").missing(),
        "commit abc1234 not found in this repo — raised normally"
    );
    assert_eq!(
        Anchor::Commit("abc1234").unusable(Unusable::NoTrunk),
        Anchor::Commit("abc1234").missing()
    );
    for (why, text) in [
        (
            Unusable::Missing,
            "no commit in this repo before the decision date 2026-05-01 — raised normally",
        ),
        (
            Unusable::Future,
            "the decision date 2026-05-01 is in the future, so no commit precedes it — raised normally",
        ),
        (
            Unusable::NoTrunk,
            "the trunk this change forks from could not be resolved (no origin/HEAD, or no \
             merge-base of it with HEAD), so nothing anchors the decision date 2026-05-01 — raised \
             normally",
        ),
        (
            Unusable::Unreadable,
            "git could not list the trunk's commits before the decision date 2026-05-01 — raised \
             normally",
        ),
    ] {
        assert_eq!(day.unusable(why), text);
    }
    for word in ["missing", "future", "no-trunk", "unreadable"] {
        assert!(Unusable::from_word(word).is_some(), "{word}");
    }
    assert_eq!(Unusable::from_word("0"), None);
}

#[test]
fn today_is_a_calendar_date() {
    let today = super::today();
    assert_eq!(calendar_date(&today), Some(today.clone()));
    assert!(today.as_str() > "2026-01-01", "{today}");
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
    let ds = [
        anchored("dated", "src/c.rs", "2026-05-02"),
        anchored("ahead", "src/d.rs", "2099-01-01"),
    ];
    let findings = vec![
        finding("dated", "src/c.rs", "Medium"),
        finding("dated", "src/c.rs", "Low"),
        finding("ahead", "src/d.rs", "Medium"),
    ];
    let check = |ds: &[&PriorDecision]| {
        let mut s = crate::memory::Scope {
            missing: ds.iter().map(|d| d.id.clone()).collect(),
            ..crate::memory::Scope::default()
        };
        let ahead = Anchor::Date("2099-01-01".into()).unusable(Unusable::Future);
        s.why_missing.insert("ahead".into(), ahead);
        s
    };
    let prepared = crate::memory::apply::prepare(&findings, &ds, &check, &[]);
    let out = crate::memory::apply::apply(findings, &prepared, None, "why");
    let named: Vec<&String> = out
        .refused
        .iter()
        .filter(|r| r.starts_with("decision "))
        .collect();
    assert_eq!(
        named,
        [
            "decision dated: no commit in this repo before the decision date 2026-05-02 — raised normally",
            "decision ahead: the decision date 2099-01-01 is in the future, so no commit precedes it — raised normally",
        ]
    );
    assert_eq!(out.reraised, 3);
    let ahead = out.kept.last().unwrap()["why"].as_str().unwrap();
    assert!(ahead.ends_with("raised again: the decision date 2099-01-01 is in the future, so no commit precedes it — raised normally."), "{ahead}");
}
