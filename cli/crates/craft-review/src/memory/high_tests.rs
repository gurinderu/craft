//! Which record sets a Critical or High finding aside (realm @nick/craft, node #196): a Critical
//! none; a High only a human's decision whose code is unchanged since its commit.

use serde_json::{Value, json};

use super::apply::{self, Scope};
use super::{PriorDecision, RecordKind};

const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";

fn finding(severity: &str) -> Value {
    json!({"severity": severity, "title": "unwrap on a checked value", "file": "src/lib.rs", "line": 11, "source": "errors", "tier": "confirmed", "why": "w"})
}

fn decision(decided_by: &str) -> PriorDecision {
    PriorDecision {
        id: "decision-a".into(),
        title: "unwrap on a checked value".into(),
        scope: "src/lib.rs".into(),
        reason: "checked above".into(),
        who: "nick".into(),
        decided_by: decided_by.into(),
        when: "2026-11-01".into(),
        link: "https://example.com/pr/1#r1".into(),
        commit: COMMIT.into(),
        line: 10,
        lens: "errors".into(),
        ..PriorDecision::default()
    }
}

/// The decisions applied to `f`, the scope check seeing every record `unchanged` or not.
fn applied(f: Value, d: PriorDecision, unchanged: bool) -> apply::Applied {
    let ds = [d];
    let check = |seen: &[&PriorDecision]| Scope {
        unchanged: if unchanged {
            seen.iter().map(|d| d.id.clone()).collect()
        } else {
            std::collections::BTreeSet::default()
        },
        ..Scope::default()
    };
    let p = apply::prepare(std::slice::from_ref(&f), &ds, &check, &[]);
    apply::apply(vec![f], &p, None)
}

fn why(f: &Value) -> &str {
    f["why"].as_str().unwrap_or("")
}

#[test]
fn a_humans_decision_sets_a_high_aside_while_its_code_is_unchanged_under_its_own_section() {
    let out = applied(finding("High"), decision("human"), true);
    assert_eq!((out.kept.len(), out.set_aside.len()), (0, 1));
    let report = apply::section(&out.set_aside);
    assert!(
        report.contains("## High rejected by a human (set aside — not in the verdict)"),
        "{report}"
    );
    assert!(
        report.contains("checked above — nick, 2026-11-01, https://example.com/pr/1#r1"),
        "{report}"
    );
    assert!(!report.contains("## Rejected before"), "{report}");
}

#[test]
fn a_humans_decision_raises_a_high_again_once_its_code_changed() {
    let out = applied(finding("High"), decision("human"), false);
    assert_eq!((out.kept.len(), out.set_aside.len()), (1, 0));
    assert!(
        why(&out.kept[0]).contains("changed since"),
        "{}",
        why(&out.kept[0])
    );
}

#[test]
fn an_agents_decision_or_one_not_saying_who_decided_raises_a_high_again() {
    for by in ["agent", "", "Human?"] {
        let out = applied(finding("High"), decision(by), true);
        assert_eq!((out.kept.len(), out.set_aside.len()), (1, 0), "{by}");
        assert!(
            why(&out.kept[0]).contains("set aside only by a human's decision (decidedBy: human)"),
            "{by}: {}",
            why(&out.kept[0])
        );
    }
}

#[test]
fn a_humans_decision_recording_a_deferral_raises_a_high_again() {
    let d = PriorDecision {
        deferred: true,
        ..decision("human")
    };
    let out = applied(finding("High"), d, true);
    assert_eq!((out.kept.len(), out.set_aside.len()), (1, 0));
    assert!(
        why(&out.kept[0]).contains("recorded deferral"),
        "{}",
        why(&out.kept[0])
    );
}

#[test]
fn decided_by_is_read_from_the_record() {
    let raw = json!({"id": "decision-a", "kind": "decision", "title": "t", "body": "b", "scope": "src", "author": "nick", "decidedBy": "human"});
    let d = super::record::read(&raw, "record").unwrap();
    assert_eq!(d.decided_by, "human");
}

#[test]
fn a_deferred_question_never_sets_a_high_aside() {
    let q = PriorDecision {
        kind: RecordKind::Question,
        deferred: true,
        ..decision("human")
    };
    let out = applied(finding("High"), q, true);
    assert_eq!((out.kept.len(), out.set_aside.len()), (1, 0));
}

#[test]
fn a_critical_is_raised_again_whatever_decision_answers_it() {
    let out = applied(finding("Critical"), decision("human"), true);
    assert_eq!((out.kept.len(), out.set_aside.len()), (1, 0));
    assert!(
        why(&out.kept[0]).contains("a Critical finding is never set aside"),
        "{}",
        why(&out.kept[0])
    );
}
