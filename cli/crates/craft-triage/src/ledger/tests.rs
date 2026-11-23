use serde_json::json;

use super::*;

#[test]
fn a_carried_and_an_unjudged_verdict_say_so() {
    let prior = LedgerEntry {
        stable_id: "r".into(),
        verdict: "defer".into(),
        reason: "later".into(),
        ..LedgerEntry::default()
    };
    let c = Validation::carried(&prior);
    assert_eq!(c.reason, "carried from prior run: later");
    assert_eq!(
        c.premise_checked,
        "(carried from prior run — not re-checked)"
    );
    let u = Validation::unjudged("x");
    assert_eq!(u.verdict, "needs-decision");
    assert!(u.reason.starts_with("NOT JUDGED — "));
    assert_eq!(
        serde_json::to_value(u.row()).unwrap(),
        json!({"stable_id": "x", "verdict": "needs-decision", "reason": u.reason})
    );
}

#[test]
fn a_validator_answer_is_read_or_refused() {
    let v = Validation::read(
        &json!({"stable_id": "a", "verdict": "accept", "reason": "r", "noise_class": 6}),
    );
    assert_eq!(v.unwrap().noise_class, Some(json!(6)));
    assert!(matches!(
        Validation::read(&json!({"verdict": "accept"})),
        Err(TriageError::Answer { .. })
    ));
}
