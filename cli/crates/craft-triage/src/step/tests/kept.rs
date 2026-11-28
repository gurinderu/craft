//! The degraded notes of a round its host ended without a submit — a stopping signal cut it short
//! — kept in the run's directory beside the answers that landed: the resume takes them, and the
//! plan leads with its DEGRADED banner (realm @nick/craft, node #752).

use serde_json::Value;

use super::{Said, Unused, answers, case, git_repo, opts_of, plan_of, start, submit};
use crate::parity::answers::CaseAnswers;

const NOTE: &str = "round 1: 1 task(s) named `x`, whose prompt body the Codex driver did not find, and ran on the bare task prompt — this run is weaker than a normal one, not broken.";

/// Runs `name` to its end, its first round's answers written to their files and `kept` kept beside
/// them, as a host a signal stopped leaves them, then taken by a resume; every later round handed in.
fn interrupted(name: &str, kept: &[String]) -> (tempfile::TempDir, Value) {
    let c = case(name);
    let (repo, dir) = (git_repo(), tempfile::tempdir().unwrap());
    let a = CaseAnswers::new(&c, None);
    start(&opts_of(&c, repo.path(), dir.path()), &Unused).unwrap();
    for (id, answer) in answers(dir.path(), &a) {
        let file = craft_step::handoff::answer_file(dir.path(), &id).unwrap();
        std::fs::write(file, answer.to_string()).unwrap();
    }
    craft_step::noted::keep(dir.path(), kept).unwrap();
    let resume = Said {
        resume: true,
        ..Said::default()
    };
    let mut step = submit(dir.path(), None, &resume, &Unused).unwrap();
    assert!(
        !craft_step::noted::file(dir.path()).exists(),
        "forgotten once the state holds them"
    );
    for _ in 0..40 {
        if step["done"] == Value::Bool(true) {
            return (dir, step);
        }
        let given = answers(dir.path(), &a);
        step = submit(dir.path(), Some(&given), &Said::default(), &Unused).unwrap();
    }
    panic!("{name}: the run did not end");
}

#[test]
fn a_resume_takes_the_notes_kept_by_an_interrupted_round_into_the_plans_banner() {
    let (_dir, step) = interrupted("repeats collapsed", &[NOTE.to_owned()]);
    let plan = plan_of(&step);
    let body = plan["plan_markdown"].as_str().unwrap();
    assert!(body.starts_with("> **DEGRADED**"), "{body}");
    assert!(body.contains(NOTE), "{body}");
    assert_eq!(plan["degraded"], serde_json::json!([NOTE]));
    assert_eq!(step["degraded"], serde_json::json!([NOTE]));
}

#[test]
fn an_interrupted_round_with_no_kept_note_plans_as_it_did() {
    let (_dir, step) = interrupted("repeats collapsed", &[]);
    let plan = plan_of(&step);
    assert!(plan.get("degraded").is_none(), "{plan}");
    assert!(step.get("degraded").is_none(), "{step}");
}
