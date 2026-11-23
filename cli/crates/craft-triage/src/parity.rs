//! The triage held to the engine's by `content/parity/triage-cases.json`, whose expected side
//! `integrations/shared/triage-parity.test.mjs` writes by running `triage-findings.js` with the
//! case's scripted answers: replayed here through this crate's functions, the same gathered
//! findings, prior ledger and answers give the same verdicts and settled rows handed to the plan
//! agent, the same record and the same plan. What is not this crate's — the memory recall, its
//! degraded notes and line — is read from the expected side as input.

use serde_json::{Value, json};

mod phases;
mod replay;

use replay::Replay;

const CASES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../content/parity/triage-cases.json"
));

fn cases() -> Vec<Value> {
    let file: Value = serde_json::from_str(CASES).unwrap();
    let cases = file["cases"].as_array().unwrap().clone();
    assert!(cases.len() >= 8, "the cases were not found");
    cases
}

#[test]
fn the_validators_asked_and_the_plan_agents_blocks_are_the_engines() {
    for case in cases() {
        let (name, want, got) = (&case["name"], &case["expected"], Replay::of(&case));
        let mut asked: Vec<&String> = want["prompts"]["validate"]
            .as_object()
            .unwrap()
            .keys()
            .collect();
        asked.sort();
        let mut got_asked: Vec<&String> = got.asked.iter().collect();
        got_asked.sort();
        assert_eq!(
            got_asked, asked,
            "{name}: the findings a validator was asked about"
        );
        assert_eq!(
            json!(got.validations),
            want["validations"],
            "{name}: the verdicts"
        );
        assert_eq!(
            json!(got.sifted),
            want["sifted"],
            "{name}: the rows settled before validation"
        );
        assert_eq!(
            got.accepted(),
            want["accepted"],
            "{name}: the accepted findings"
        );
    }
}

#[test]
fn the_record_and_the_plan_are_the_engines() {
    for case in cases() {
        let (name, want) = (&case["name"], &case["expected"]);
        let (record, plan) = Replay::of(&case).finish(&case["answers"]["plan"], want);
        assert_eq!(record, want["record"], "{name}: the record");
        assert_eq!(plan, want["plan"], "{name}: the plan");
    }
}
