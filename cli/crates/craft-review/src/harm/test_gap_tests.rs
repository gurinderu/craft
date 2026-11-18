//! A weak assertion naming its regression is rated by that regression's harm, held to should-fix,
//! and verified; a test gap naming no regression stays Low and unverified.

use serde_json::{Value, json};

use super::raise_weak_floor;
use crate::harm::cap;
use crate::settle::finalize;
use crate::verify::{Route, route};

fn gap(extra: &Value) -> Value {
    let mut f = json!({"severity": "Low", "title": "t", "file": "src/a.rs", "line": 3, "why": "w",
                       "ruleId": "", "source": "tests", "harmLevel": "outage",
                       "testGap": "weak-assertion",
                       "regression": "the handler stops applying the field and answers 200"});
    if let (Some(o), Some(e)) = (f.as_object_mut(), extra.as_object()) {
        o.extend(e.clone());
    }
    f
}

/// `f` confirmed by a verifier who backed `level`.
fn confirmed(f: &Value, level: &str) -> Value {
    let mut out = f.clone();
    out["tier"] = json!("confirmed");
    out["harmVerified"] = json!(level);
    out
}

#[test]
fn a_weak_assertion_naming_a_behaviour_regression_is_medium_and_verified() {
    let f = raise_weak_floor(&gap(&json!({})));
    assert_eq!(f["severity"], "Medium");
    assert!(f["why"].as_str().unwrap().contains("weak assertion"));
    assert_eq!(route(&f), Route::Batch);
    let settled = finalize(&confirmed(&f, "outage"));
    assert_eq!(settled["severity"], "Medium", "{settled}");
}

#[test]
fn a_weak_assertion_is_held_to_should_fix() {
    let f = gap(&json!({"severity": "High", "harmLevel": "security"}));
    assert_eq!(cap(&f)["severity"], "Medium");
    assert_eq!(finalize(&confirmed(&f, "security"))["severity"], "Medium");
    assert_eq!(raise_weak_floor(&f), f, "a floor never lowers");
}

#[test]
fn a_weak_assertion_of_text_or_self_healing_stays_low() {
    for level in ["text", "self-healing", "none"] {
        let f = gap(&json!({"harmLevel": level}));
        assert_eq!(raise_weak_floor(&f), f, "{level}");
        assert_eq!(route(&f), Route::Skip, "{level}");
    }
    let op = raise_weak_floor(&gap(&json!({"harmLevel": "operator-recovery"})));
    assert_eq!(op["severity"], "Medium");
}

#[test]
fn a_test_gap_naming_no_regression_stays_low_and_unverified() {
    for kind in ["missing", "weak-assertion"] {
        let f = gap(&json!({"testGap": kind, "regression": " ", "severity": "Medium"}));
        let floored = raise_weak_floor(&f);
        assert_eq!(cap(&floored)["severity"], "Low", "{kind}");
        let low = gap(&json!({"testGap": kind, "regression": ""}));
        assert_eq!(raise_weak_floor(&low), low, "{kind}");
        assert_eq!(route(&low), Route::Skip, "{kind}");
    }
}

#[test]
fn a_missing_test_naming_its_defect_keeps_that_defect_s_ceiling() {
    let f = gap(&json!({"testGap": "missing", "severity": "High", "harmLevel": "security"}));
    assert_eq!(raise_weak_floor(&f), f);
    assert_eq!(cap(&f)["severity"], "High");
}

#[test]
fn only_the_tests_lens_alone_is_read_for_a_test_gap() {
    let other = gap(&json!({"source": "correctness"}));
    assert_eq!(raise_weak_floor(&other), other);
    let merged = gap(&json!({"severity": "High", "sources": ["tests", "errors"]}));
    assert_eq!(cap(&merged)["severity"], "High");
}
