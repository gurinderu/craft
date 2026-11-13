//! Which Low findings buy a verifier: those on a failure path, by the lens that read them, the rule
//! they cite or their deletion/recovery flag; every other Low and every Info stays unverified.

use serde_json::{Value, json};

use super::{Route, route, route_in};

fn low(extra: &Value) -> Value {
    let mut f = json!({"severity": "Low", "title": "t", "file": "src/a.rs", "line": 3, "why": "w",
                       "ruleId": "", "source": "correctness"});
    if let (Some(o), Some(e)) = (f.as_object_mut(), extra.as_object()) {
        o.extend(e.clone());
    }
    f
}

#[test]
fn a_low_from_a_failure_path_lens_is_batched() {
    for lens in ["failure-windows", "reconciler", "concurrency", "errors"] {
        assert_eq!(
            route(&low(&json!({"source": lens}))),
            Route::Batch,
            "{lens}"
        );
    }
}

#[test]
fn a_merged_low_one_of_whose_lenses_reads_failure_paths_is_batched() {
    let f = low(&json!({"source": "correctness", "sources": ["correctness", "reconciler"]}));
    assert_eq!(route(&f), Route::Batch);
}

#[test]
fn a_low_citing_a_reconcile_concurrency_or_error_rule_is_batched() {
    for rule in ["REC-004", "CON-002", "ERR-003"] {
        assert_eq!(
            route(&low(&json!({"ruleId": rule}))),
            Route::Batch,
            "{rule}"
        );
    }
}

#[test]
fn a_low_flagged_on_a_deletion_or_recovery_path_is_batched() {
    let f = low(&json!({"deletionOrRecoveryPath": true}));
    assert_eq!(route(&f), Route::Batch);
}

#[test]
fn other_lows_and_every_info_stay_unverified() {
    assert_eq!(route(&low(&json!({}))), Route::Skip);
    assert_eq!(route(&low(&json!({"ruleId": "MNT-001"}))), Route::Skip);
    let info = json!({"severity": "Info", "source": "failure-windows", "ruleId": "", "deletionOrRecoveryPath": true});
    assert_eq!(route(&info), Route::Skip);
}

#[test]
fn a_light_pass_still_verifies_only_medium_and_above() {
    let f = low(&json!({"source": "failure-windows"}));
    assert_eq!(route_in(&f, true), Route::Skip);
    assert_eq!(route_in(&f, false), Route::Batch);
}
