//! The triage held to the engine's by `content/parity/triage-cases.json`, whose expected side
//! `integrations/shared/triage-parity.test.mjs` writes by running `triage-findings.js` with the
//! case's scripted answers.
//!
//! Replayed here through this crate's functions, the same gathered findings, prior ledger and
//! answers give the same verdicts and settled rows handed to the plan agent, the same record and
//! the same plan — compared as JSON text, so a key out of the engine's order fails as surely as a
//! wrong value. What is not this crate's — the memory recall, its degraded notes and line, the
//! memory's own sift — is read from the expected side as input, and the replay validates every
//! finding the batch kept: the cases recall no record that sets one aside.

mod phases;
mod replay;

use crate::json::Json;
use replay::Replay;

const CASES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../content/parity/triage-cases.json"
));

fn cases() -> Vec<Json> {
    let file: Json = serde_json::from_str(CASES).unwrap();
    let cases = file.at("cases").as_array().unwrap().to_vec();
    assert!(cases.len() >= 8, "the cases were not found");
    cases
}

fn text(v: &Json) -> String {
    serde_json::to_string(v).unwrap()
}

#[test]
fn the_validators_asked_and_the_plan_agents_blocks_are_the_engines() {
    for case in cases() {
        let (name, want, got) = (
            text(case.at("name")),
            case.at("expected"),
            Replay::of(&case),
        );
        let mut asked: Vec<&str> = want
            .at("prompts")
            .at("validate")
            .as_object()
            .unwrap()
            .keys()
            .collect();
        asked.sort_unstable();
        let mut got_asked: Vec<&str> = got.asked.iter().map(String::as_str).collect();
        got_asked.sort_unstable();
        assert_eq!(
            got_asked, asked,
            "{name}: the findings a validator was asked about"
        );
        let rows = |r: &[crate::ledger::Row]| text(&Json::from(r.to_vec()));
        assert_eq!(
            rows(&got.validations),
            text(want.at("validations")),
            "{name}: the verdicts"
        );
        assert_eq!(
            rows(&got.sifted),
            text(want.at("sifted")),
            "{name}: the rows settled before validation"
        );
        assert_eq!(
            text(&got.accepted()),
            text(want.at("accepted")),
            "{name}: the accepted findings"
        );
    }
}

#[test]
fn the_record_and_the_plan_are_the_engines_to_the_byte() {
    for case in cases() {
        let (name, want) = (text(case.at("name")), case.at("expected"));
        let (record, plan) = Replay::of(&case).finish(case.at("answers").at("plan"), want);
        assert_eq!(text(&record), text(want.at("record")), "{name}: the record");
        assert_eq!(text(&plan), text(want.at("plan")), "{name}: the plan");
    }
}
