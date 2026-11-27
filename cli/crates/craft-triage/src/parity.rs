//! The triage held to the JavaScript engine it replaced by `content/parity/triage-cases.json`:
//! what that engine dispatched, filed and returned for each case's scripted answers, frozen golden
//! data edited by hand since the binary took the triage over (realm @nick/craft, node #616).
//!
//! The run ([`crate::run`]) is driven here by the same arguments and answers — the scope check and
//! the memory's judges answered as the case scripts them — and gives the same prompts to every
//! agent, the same record and the same plan, compared as text, so a key out of the engine's order
//! fails as surely as a wrong value. Only the craft version is read from the expected side (realm
//! @nick/craft, node #629).

pub(crate) mod answers;

use craft_store::js::Js;

use crate::field::At;
use crate::run::{Ask, Phase, Progress, run};
use answers::{CaseAnswers, args_of};

const CASES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../content/parity/triage-cases.json"
));

pub(crate) fn cases() -> Vec<Js> {
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

/// The asks of `phase` when the case's answers to it are held back, none when the run asks no
/// agent of it.
fn asked_in(case: &Js, phase: Phase) -> Vec<Ask> {
    let a = CaseAnswers::new(case, Some(phase));
    match run(&args_of(case), &a, &|ds| a.scope(ds)).unwrap() {
        Progress::Asks(p, asks) if p == phase => asks,
        Progress::Asks(..) | Progress::Done(_) => Vec::new(),
    }
}

/// The model each kind of agent runs on, as the engine names it: judgement against the code and
/// the plan on Opus, extraction and lookup on Sonnet (realm @nick/craft, node #553).
fn model_of(kind: &crate::kind::TriageKind) -> craft_step::Model {
    use crate::kind::TriageKind as K;
    match kind {
        K::Validate { .. } | K::Plan => craft_step::Model::Opus,
        K::GatherReport | K::GatherPr | K::Recall { .. } | K::MatchJudge | K::RuleJudge { .. } => {
            craft_step::Model::Sonnet
        }
    }
}

#[test]
fn every_agent_runs_on_the_model_the_engine_names_and_the_memorys_prompts_are_the_engines() {
    let phases = [
        Phase::Gather,
        Phase::Recall,
        Phase::Match,
        Phase::Rules,
        Phase::Validate,
        Phase::Plan,
    ];
    for case in cases() {
        let name = text(case.at("name"));
        let mut memory = Vec::new();
        for phase in phases {
            for a in asked_in(&case, phase) {
                assert_eq!(
                    a.model,
                    model_of(&a.kind),
                    "{name}: the model of {}",
                    a.label
                );
                if matches!(phase, Phase::Recall | Phase::Match | Phase::Rules) {
                    memory.push((a.label, a.prompt));
                }
            }
        }
        let want: Vec<(String, String)> = case
            .at("expected")
            .at("prompts")
            .at("memory")
            .as_arr()
            .unwrap()
            .iter()
            .map(|m| (text_of(m.at("label")), text_of(m.at("prompt"))))
            .collect();
        assert_eq!(
            memory, want,
            "{name}: the memory's agents and their prompts"
        );
    }
}

fn text_of(v: &Js) -> String {
    v.as_str().unwrap().to_owned()
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
                        let crate::kind::TriageKind::Validate { finding: id } = a.kind else {
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
        assert_eq!(
            text(&done.plan(&[])),
            text(want.at("plan")),
            "{name}: the plan"
        );
    }
}
