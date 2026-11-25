use craft_review::memory::{Memory, PriorDecision, RecordKind, Scope};
use craft_store::js::{Js, Obj};
use serde_json::json;

use super::*;
use crate::finding::{Finding, id_of};

const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";

fn sifted(severity: &str, title: &str, location: &str) -> Sifted {
    let f = Finding(
        Obj::new()
            .with("severity", Js::str(severity))
            .with("title", Js::str(title))
            .with("location", Js::str(location))
            .with("detail", Js::str(format!("why {title}")))
            .with("thread_id", Js::str(""))
            .with("source", Js::str("report")),
    );
    let id = id_of(&f);
    Sifted::new(f, id)
}

fn record(id: &str, kind: RecordKind, title: &str) -> PriorDecision {
    PriorDecision {
        id: id.into(),
        kind,
        title: title.into(),
        scope: "src/a.rs".into(),
        reason: "checked above".into(),
        who: "nick".into(),
        when: "2026-11-01".into(),
        link: "https://example.com/pr/1#r1".into(),
        commit: COMMIT.into(),
        deferred: kind == RecordKind::Question,
        line: 10,
        ..PriorDecision::default()
    }
}

/// The memory's split of `kept` by `records`, the scope seen unchanged and the match judge's
/// `answer` given.
fn sift(
    kept: &[Sifted],
    records: Vec<PriorDecision>,
    answer: Option<&serde_json::Value>,
) -> Settled {
    let mut m = Memory {
        decisions: records,
        ..Memory::default()
    };
    let check = |ds: &[&PriorDecision]| Scope {
        unchanged: ds.iter().map(|d| d.id.clone()).collect(),
        ..Scope::default()
    };
    let values = as_values(kept);
    m.match_ask(&values, &[], &check).unwrap();
    let mut decided = m.decide(values, (answer, &[]), &check, NOTE);
    let ruled = m.rule(std::mem::take(&mut decided.kept), (&[], &[]), NOTE);
    settled(kept, decided, ruled)
}

#[test]
fn a_decision_sets_its_finding_aside_as_a_rejection_marked_with_who_and_how() {
    let kept = [
        sifted("Medium", "unwrap on input", "src/a.rs:10"),
        sifted("Low", "nit", ""),
    ];
    let s = sift(
        &kept,
        vec![record(
            "decision-a",
            RecordKind::Decision,
            "unwrap on input",
        )],
        None,
    );
    assert_eq!(s.to_validate.len(), 1);
    assert_eq!(s.to_validate[0].stable_id, kept[1].stable_id);
    let row = Js::from(s.ledger[0].clone()).compact();
    assert!(row.starts_with(r#"{"stable_id":"report::src/a.rs:10::unwrap on input","verdict":"reject","sifted":true,"reason":"SIFTED BEFORE VALIDATION — REJECTED BEFORE: checked above — nick, 2026-11-01"#), "{row}");
    assert_eq!(
        s.counts,
        SiftCounts {
            rejected_before: 1,
            ..SiftCounts::default()
        }
    );
}

#[test]
fn a_deferred_question_defers_its_finding() {
    let kept = [sifted("Medium", "unwrap on input", "src/a.rs:10")];
    let s = sift(
        &kept,
        vec![record(
            "question-a",
            RecordKind::Question,
            "unwrap on input",
        )],
        None,
    );
    assert_eq!(s.ledger[0].verdict(), "defer");
    assert!(
        s.ledger[0].text("reason").contains("KNOWN AND DEFERRED"),
        "{:?}",
        s.ledger[0]
    );
    assert_eq!(s.counts.deferred, 1);
}

#[test]
fn a_critical_is_raised_again_with_its_note_for_the_validator() {
    let kept = [sifted("Critical", "unwrap on input", "src/a.rs:10")];
    let s = sift(
        &kept,
        vec![record(
            "decision-a",
            RecordKind::Decision,
            "unwrap on input",
        )],
        None,
    );
    assert!(s.ledger.is_empty());
    assert_eq!(s.counts.reraised, 1);
    let note = s.to_validate[0].memory_note.to_utf8_lossy();
    assert!(
        note.contains("raised again: a Critical finding is never set aside"),
        "{note}"
    );
}

#[test]
fn a_finding_the_judge_shows_against_its_record_is_a_conflict_not_validated() {
    let kept = [sifted("Medium", "unwrap on input", "src/a.rs:10")];
    let answer = json!({"verdicts": [{"pair": 0, "same": false, "violates": true, "why": "the guard went"}]});
    let s = sift(
        &kept,
        vec![record(
            "decision-a",
            RecordKind::Decision,
            "unwrap on input",
        )],
        Some(&answer),
    );
    assert!(s.to_validate.is_empty());
    assert_eq!(s.ledger[0].verdict(), "conflict");
    assert_eq!(
        s.ledger[0].text("reason"),
        "SIFTED BEFORE VALIDATION — goes against decision decision-a in project memory (the guard went); a human decides whether the record still stands"
    );
    assert_eq!(s.counts.conflict, 1);
}

#[test]
fn with_no_record_every_finding_goes_on_unmarked() {
    let kept = [sifted("Medium", "unwrap on input", "src/a.rs:10")];
    let s = sift(&kept, Vec::new(), None);
    assert_eq!(s.to_validate, kept.to_vec());
    assert!(s.ledger.is_empty() && s.refused.is_empty());
}

#[test]
fn a_mark_loses_only_its_leading_dot() {
    assert_eq!(mark(&" · A · B".into()).to_utf8_lossy(), "A · B");
    assert_eq!(mark(&"A".into()).to_utf8_lossy(), "A");
}
