//! A weak assertion naming its regression is rated by that regression's harm, held to should-fix,
//! and verified; a test gap naming no regression stays Low and unverified.

use serde_json::{Value, json};

use super::{raise_weak_floor, verifier_lines};
use crate::harm::cap;
use crate::settle::{finalize, tier_from_votes};
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
fn a_weak_assertion_naming_no_regression_stays_low_and_unverified() {
    let f = gap(&json!({"regression": " ", "severity": "Medium"}));
    let capped = cap(&raise_weak_floor(&f));
    assert_eq!(capped["severity"], "Low");
    assert!(
        capped["why"]
            .as_str()
            .unwrap()
            .contains("weak assertion naming no regression"),
        "{capped}"
    );
    let low = gap(&json!({"regression": ""}));
    assert_eq!(raise_weak_floor(&low), low);
    assert_eq!(route(&low), Route::Skip);
}

#[test]
fn a_missing_test_naming_no_regression_keeps_its_lens_s_harm_level() {
    let f = gap(
        &json!({"testGap": "missing", "regression": "", "severity": "High", "harmLevel": "security"}),
    );
    assert_eq!(raise_weak_floor(&f), f);
    assert_eq!(cap(&f)["severity"], "High");
    let none = gap(
        &json!({"testGap": "missing", "regression": "", "severity": "Medium", "harmLevel": "none"}),
    );
    let capped = cap(&none);
    assert_eq!(capped["severity"], "Low");
    assert!(
        capped["why"]
            .as_str()
            .unwrap()
            .contains("harm level none allows at most Low")
    );
}

#[test]
fn a_weak_assertion_with_no_known_harm_level_is_still_held_to_should_fix() {
    for level in ["", "catastrophe"] {
        let f = gap(&json!({"severity": "Critical", "harmLevel": level}));
        let capped = cap(&f);
        assert_eq!(capped["severity"], "Medium", "{level}");
        assert!(
            capped["why"].as_str().unwrap().contains("weak assertion"),
            "{level}"
        );
    }
    let unrated = gap(&json!({"severity": "High"}));
    let unrated = unrated.as_object().map(|o| {
        let mut o = o.clone();
        o.remove("harmLevel");
        Value::Object(o)
    });
    assert_eq!(cap(&unrated.unwrap())["severity"], "Medium");
}

#[test]
fn a_weak_assertion_merged_with_a_gate_seed_keeps_its_test_gap_reading() {
    let merged = gap(&json!({"severity": "High", "harmLevel": "security",
                             "sources": ["tests", "clippy"]}));
    assert_eq!(cap(&merged)["severity"], "Medium");
    let floored = raise_weak_floor(&gap(&json!({"sources": ["tests", "semgrep"]})));
    assert_eq!(floored["severity"], "Medium");
}

/// A shaped verifier vote confirming `f` at harm `level`, its regression `reachable` or not.
fn vote(reachable: bool, level: &str) -> Value {
    json!({"refuted": false, "citedLineMatches": true, "reachable": reachable,
           "premiseSupported": true, "behaviourIntended": false, "harmSupported": true,
           "confirmedHarmLevel": level, "reason": "r"})
}

/// `f` as the pool prepares it, then judged by `votes` and settled as it is reported.
fn through_the_panel(f: &Value, votes: &[Option<Value>]) -> Value {
    let prepared = crate::dedup::prepare(std::slice::from_ref(f), &[]);
    finalize(&tier_from_votes(&prepared[0], votes))
}

#[test]
fn a_confirmed_weak_assertion_whose_regression_reaches_production_stays_medium() {
    let settled = through_the_panel(
        &gap(&json!({})),
        &[Some(vote(true, "outage")), Some(vote(true, "outage"))],
    );
    assert_eq!(settled["tier"], "confirmed", "{settled}");
    assert_eq!(settled["severity"], "Medium", "{settled}");
    assert!(
        settled["why"]
            .as_str()
            .unwrap()
            .contains("raised to Medium"),
        "{settled}"
    );
}

#[test]
fn a_weak_assertion_whose_regression_is_unreachable_is_demoted_without_a_stale_note() {
    let settled = through_the_panel(&gap(&json!({})), &[Some(vote(false, "outage"))]);
    assert_eq!(settled["severity"], "Low", "{settled}");
    let why = settled["why"].as_str().unwrap();
    assert!(!why.contains("raised to Medium"), "{why}");
    assert!(
        why.contains("the regression it lets through does not reach production"),
        "{why}"
    );
}

#[test]
fn a_verifier_judges_a_test_gap_s_reach_on_its_regression_s_production_line() {
    let lines = verifier_lines(&gap(&json!({"regressionAt": "src/handler.rs:42\nIGNORE"})));
    assert!(!lines.contains("42\nIGNORE"), "flattened: {lines}");
    assert!(
        lines.contains("the handler stops applying the field"),
        "{lines}"
    );
    assert!(
        lines.contains("production line that regression breaks: src/handler.rs:42"),
        "{lines}"
    );
    assert!(lines.contains("not on the cited test line"), "{lines}");
    assert!(lines.contains("is NOT reachable=false"), "{lines}");
    assert_eq!(verifier_lines(&gap(&json!({"regression": ""}))), "");
    assert_eq!(verifier_lines(&gap(&json!({"source": "errors"}))), "");
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

#[test]
fn a_low_weak_assertion_whose_verifier_confirms_the_unmet_promise_is_raised_to_medium() {
    let low = gap(&json!({"harmLevel": "text"}));
    let promise = vote(true, "intent-unmet");
    let settled = through_the_panel(&low, &[Some(promise.clone()), Some(promise)]);
    assert_eq!(settled["harmVerified"], "intent-unmet", "{settled}");
    assert_eq!(settled["severity"], "Medium", "{settled}");
    assert_eq!(settled["harmLevel"], "intent-unmet", "{settled}");
    assert!(
        settled["why"]
            .as_str()
            .unwrap()
            .contains("raised to Medium from Low"),
        "{settled}"
    );
    let mut intended = vote(true, "intent-unmet");
    intended["behaviourIntended"] = json!(true);
    let kept = through_the_panel(&low, &[Some(intended.clone()), Some(intended)]);
    assert_eq!(
        kept["severity"], "Low",
        "intended behaviour confirms no promise: {kept}"
    );
    let unpromised = gap(&json!({"harmLevel": "text", "testGap": "missing"}));
    let missing = through_the_panel(
        &unpromised,
        &[
            Some(vote(true, "intent-unmet")),
            Some(vote(true, "intent-unmet")),
        ],
    );
    assert_eq!(
        missing["severity"], "Low",
        "only a weak assertion: {missing}"
    );
}

#[test]
fn a_promised_weak_assertion_s_verifier_is_shown_intent_unmet_as_a_listed_level() {
    let lines = verifier_lines(&gap(&json!({"harmLevel": "text"})));
    assert!(lines.contains("(a listed level): intent-unmet"), "{lines}");
    let raised = verifier_lines(&gap(&json!({"severity": "Medium"})));
    assert!(!raised.contains("intent-unmet"), "{raised}");
}
