//! The prompts each case dispatched, rendered here from the same inputs as the engine's.

use super::phases::text;
use super::replay::Replay;
use super::{cases, text as compact};
use crate::field::At;
use crate::noise::{class_one_base_line, effective_pr_base};
use crate::prompts::{self, Planned, directive};

#[test]
fn every_prompt_a_case_dispatched_is_the_engines() {
    for case in cases() {
        let (name, args, want) = (
            compact(case.at("name")),
            case.at("args"),
            case.at("expected").at("prompts"),
        );
        let repo = directive(&text(args, "repo"));
        for (label, prompt) in want.at("gather").as_obj().unwrap().iter() {
            let got = match label.to_utf8_lossy().as_str() {
                "gather:report" => prompts::gather_report(&text(args, "report")).unwrap(),
                "gather:pr" => format!("{repo}{}", prompts::gather_pr(&text(args, "pr")).unwrap()),
                other => panic!("{name}: an unknown gatherer {other}"),
            };
            assert_eq!(Some(got.as_str()), prompt.as_str(), "{name}: {label:?}");
        }
        let got = Replay::of(&case);
        let base = text(args, "base");
        let class_one = class_one_base_line(&effective_pr_base(&text(args, "prBase"), &base));
        let pin = prompts::pin(&base);
        let asked = want.at("validate").as_obj().unwrap();
        for s in got.to_validate() {
            let Some(prompt) = asked.get(&s.stable_id) else {
                continue;
            };
            let at = prompts::At {
                id: &s.stable_id.to_utf8_lossy(),
                pin: &pin,
                class_one_base: &class_one,
                memory_note: &s.memory_note.to_utf8_lossy(),
            };
            let rendered = format!("{repo}{}", prompts::validate(&s.finding.0, &at).unwrap());
            assert_eq!(
                Some(rendered.as_str()),
                prompt.as_str(),
                "{name}: the validator of {:?}",
                s.stable_id
            );
        }
        let Some(plan) = want.at("plan").as_str() else {
            continue;
        };
        let (validations, sifted) = got.blocks();
        let accepted = got.accepted();
        let p = Planned {
            accepted: &accepted,
            validations: &validations,
            sifted: &sifted,
        };
        assert_eq!(
            format!("{repo}{}", prompts::plan(&p).unwrap()),
            plan,
            "{name}: the plan"
        );
    }
}
