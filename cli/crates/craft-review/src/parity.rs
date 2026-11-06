//! The verification rules this crate copies from the engines, held to them by one shared file,
//! `content/parity/verify-cases.json`, which `lib/verify-parity.test.mjs` reads too.

use serde_json::Value;

use crate::harm::LEVELS;
use crate::settle::{demote, settle};
use crate::verify::{BATCH_SIZE, CRITICAL_TIER_RULES, alone};

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

#[test]
fn every_case_settles_as_the_engines_settle_it() {
    let c = cases();
    let all = c["cases"].as_array().unwrap();
    assert!(!all.is_empty());
    for case in all {
        let name = case["name"].as_str().unwrap();
        let vote = Some(&case["vote"]).filter(|v| !v.is_null());
        let (tier, f) = settle(&case["finding"], vote);
        let want = &case["expected"];
        assert_eq!(tier.name(), want["tier"], "{name}: tier");
        assert_eq!(f["severity"], want["severity"], "{name}: severity");
        if let Some(route) = want.get("route") {
            let got = if alone(&case["finding"]) {
                "individual"
            } else {
                "batch"
            };
            assert_eq!(got, route, "{name}: route");
        }
    }
}
