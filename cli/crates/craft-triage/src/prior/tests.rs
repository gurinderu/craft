use serde_json::json;

use super::*;

#[test]
fn the_prior_ledger_is_read_as_far_as_its_entries_are_objects() {
    let by = ledger_by_id(&[
        json!({"stable_id": "a", "verdict": "reject", "reason": "no"}),
        json!("not an object"),
        Value::Null,
        json!({"stable_id": 7, "sifted": true}),
        json!({"verdict": null}),
    ]);
    assert_eq!(by.len(), 3);
    assert_eq!(by["a"].reason, "no");
    assert_eq!(by["a"].sifted, Some(false));
    assert_eq!(by["7"].sifted, Some(true));
    assert_eq!(by["7"].verdict, "");
    assert_eq!(by["undefined"].verdict, "");
}

#[test]
fn only_a_judged_reject_defer_or_needs_decision_is_settled() {
    let by = ledger_by_id(&[
        json!({"stable_id": "r", "verdict": "reject", "reason": "no"}),
        json!({"stable_id": "a", "verdict": "accept", "reason": "ok"}),
        json!({"stable_id": "c", "verdict": "conflict", "reason": "x"}),
        json!({"stable_id": "u", "verdict": "needs-decision", "reason": "carried: NOT JUDGED — died"}),
        json!({"stable_id": "s", "verdict": "defer", "reason": "later", "sifted": true}),
        json!({"stable_id": "m", "verdict": "reject", "reason": "SIFTED BEFORE VALIDATION — y"}),
    ]);
    assert_eq!(
        settled_prior(&by, "r").map(|e| e.reason.as_str()),
        Some("no")
    );
    for id in ["a", "c", "u", "s", "m", "missing"] {
        assert!(settled_prior(&by, id).is_none(), "{id}");
    }
}
