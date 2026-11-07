//! The verification rules this crate copies from the engines, held to them by one shared file,
//! `content/parity/verify-cases.json`, which `lib/verify-parity.test.mjs` reads too.

use serde_json::Value;

use crate::harm::LEVELS;
use crate::settle::{Tier, agree, demote, finalize, tier_from_votes};
use crate::verify::{BATCH_SIZE, CRITICAL_TIER_RULES, route};

const CASES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../content/parity/verify-cases.json"
));

fn cases() -> Value {
    serde_json::from_str(CASES).expect("the parity file is JSON")
}

#[test]
fn the_constants_are_the_engines() {
    let c = cases();
    assert_eq!(c["batchSize"], BATCH_SIZE);
    let rules: Vec<&str> = c["criticalTierRules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r.as_str().unwrap())
        .collect();
    assert_eq!(rules, CRITICAL_TIER_RULES);
    for (from, to) in c["demote"].as_object().unwrap() {
        assert_eq!(demote(from), to.as_str(), "demote {from}");
    }
    let ceilings: Vec<(&str, &str)> = c["harmCeiling"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p[0].as_str().unwrap(), p[1].as_str().unwrap()))
        .collect();
    assert_eq!(ceilings, LEVELS);
}

/// The votes of a case as they came back: `null` for a voter that returned nothing.
fn votes(raw: &Value) -> Vec<Option<Value>> {
    raw.as_array()
        .unwrap()
        .iter()
        .map(|v| Some(v.clone()).filter(|v| !v.is_null()))
        .collect()
}

/// `got` holds what `want` names: the tier, the final severity and, where the case names them, the
/// discarded votes, the verified harm and the whole `why`.
fn holds(name: &str, got: &Value, want: &Value) {
    assert_eq!(Tier::of(got).name(), want["tier"], "{name}: tier");
    assert_eq!(got["severity"], want["severity"], "{name}: severity");
    for k in ["votesDiscarded", "harmVerified", "why"] {
        if let Some(w) = want.get(k) {
            assert_eq!(&got[k], w, "{name}: {k}");
        }
    }
}

#[test]
fn every_case_settles_as_the_engines_settle_it() {
    let c = cases();
    let all = c["cases"].as_array().unwrap();
    assert!(!all.is_empty());
    for case in all {
        let name = case["name"].as_str().unwrap();
        let vote: Vec<Option<Value>> = Some(case["vote"].clone())
            .filter(|v| !v.is_null())
            .into_iter()
            .map(Some)
            .collect();
        let f = finalize(&tier_from_votes(&case["finding"], &vote));
        holds(name, &f, &case["expected"]);
        assert_eq!(
            route(&case["finding"]).name(),
            case["expected"]["route"],
            "{name}: route"
        );
    }
}

#[test]
fn every_panel_settles_as_the_engines_settle_it() {
    let c = cases();
    let all = c["panelCases"].as_array().unwrap();
    assert!(all.len() >= 3);
    for case in all {
        let name = case["name"].as_str().unwrap();
        let f = finalize(&tier_from_votes(&case["finding"], &votes(&case["votes"])));
        holds(name, &f, &case["expected"]);
    }
}

#[test]
fn a_deciding_pair_stands_only_when_it_agrees_as_the_engines_read_it() {
    let c = cases();
    for case in c["agreeCases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let pair = case["pair"].as_array().unwrap();
        assert_eq!(agree(&pair[0], &pair[1]), case["agree"], "{name}");
    }
}
