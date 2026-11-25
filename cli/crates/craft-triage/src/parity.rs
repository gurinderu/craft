//! The triage held to the engine's by `content/parity/triage-cases.json`, whose expected side
//! `integrations/shared/triage-parity.test.mjs` writes by running `triage-findings.js` with the
//! case's scripted answers.
//!
//! The run ([`crate::run`]) is driven here by the same arguments and answers — the scope check and
//! the memory's judges answered as the case scripts them — and gives the same prompts to every
//! agent, the same record and the same plan, compared as text, so a key out of the engine's order
//! fails as surely as a wrong value. Only the craft version is read from the expected side (realm
//! @nick/craft, node #629).

mod answers;

use craft_store::js::Js;

use crate::field::At;
use crate::run::{Ask, Phase, Progress, run};
use answers::{CaseAnswers, args_of};

const CASES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../content/parity/triage-cases.json"
));

fn cases() -> Vec<Js> {
    let file = craft_store::js::parse(CASES).unwrap();
    let cases = file.at("cases").as_arr().unwrap().to_vec();
    assert!(cases.len() >= 8, "the cases were not found");
    cases
}

fn text(v: &Js) -> String {
    v.compact()
}

/// The asks of `phase` when the case's answers to it are held back.
fn asks_of(case: &Js, phase: Phase) -> Vec<Ask> {
    let a = CaseAnswers::new(case, Some(phase));
    match run(&args_of(case), &a, &|ds| a.scope(ds)).unwrap() {
        Progress::Asks(p, asks) if p == phase => asks,
        other @ (Progress::Asks(..) | Progress::Done(_)) => panic!(
            "{}: {phase:?} was not asked: {other:?}",
            text(case.at("name"))
        ),
    }
}

/// The prompts the engine dispatched under `key` (`gather`, `validate`), by their key.
fn dispatched<'a>(case: &'a Js, key: &str) -> Vec<(String, &'a str)> {
    let o = case.at("expected").at("prompts").at(key).as_obj().unwrap();
    o.iter()
        .map(|(k, v)| (k.to_utf8_lossy(), v.as_str().unwrap()))
        .collect()
}

#[test]
fn every_prompt_a_case_dispatched_is_the_engines() {
    for case in cases() {
        let name = text(case.at("name"));
        let gathered: Vec<(String, String)> = asks_of(&case, Phase::Gather)
            .into_iter()
            .map(|a| (a.label, a.prompt))
            .collect();
        let want: Vec<(String, String)> = dispatched(&case, "gather")
            .into_iter()
            .map(|(k, v)| (k, v.to_owned()))
            .collect();
        assert_eq!(gathered, want, "{name}: the gatherers");
        let mut validated: Vec<(String, String)> =
            match case.at("expected").at("prompts").at("validate").as_obj() {
                Some(o) if o.is_empty() => Vec::new(),
                _ => asks_of(&case, Phase::Validate)
                    .into_iter()
                    .map(|a| {
                        let crate::kind::TriageKind::Validate { id } = a.kind else {
                            panic!("{name}: {:?} among the validators", a.kind);
                        };
                        (id, a.prompt)
                    })
                    .collect(),
            };
        let mut want: Vec<(String, String)> = dispatched(&case, "validate")
            .into_iter()
            .map(|(k, v)| (k, v.to_owned()))
            .collect();
        validated.sort();
        want.sort();
        assert_eq!(
            validated, want,
            "{name}: the validators asked and their prompts"
        );
        let plan = asks_of(&case, Phase::Plan);
        let want = case.at("expected").at("prompts").at("plan").as_str();
        assert_eq!(
            plan.first().map(|a| a.prompt.as_str()),
            want,
            "{name}: the plan agent"
        );
    }
}

#[test]
fn the_record_and_the_plan_are_the_engines_to_the_byte() {
    for case in cases() {
        let (name, want) = (text(case.at("name")), case.at("expected"));
        let a = CaseAnswers::new(&case, None);
        let Progress::Done(done) = run(&args_of(&case), &a, &|ds| a.scope(ds)).unwrap() else {
            panic!("{name}: the run did not finish");
        };
        assert_eq!(
            text(&done.record),
            text(want.at("record")),
            "{name}: the record"
        );
        assert_eq!(text(&done.plan), text(want.at("plan")), "{name}: the plan");
    }
}
