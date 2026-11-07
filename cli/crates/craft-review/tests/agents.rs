//! The agents a run's tasks name, and how the host says it ran them without: the degraded notes a
//! submit carries reach the report and the finished step.

mod common;

use common::{answers, finding, fixture, ids, lens, opts, small_run};
use craft_review::state;
use craft_review::step;
use serde_json::{Value, json};

/// The `agentType` each task of step `s` names, `None` where it names none.
fn agent_types(s: &Value) -> Vec<Option<&str>> {
    s["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|t| t.get("agentType").and_then(Value::as_str))
        .collect()
}

#[test]
fn only_the_lens_tasks_name_the_profile_agent() {
    let repo = fixture(true);
    let scouted = tempfile::tempdir().unwrap();
    let scout = step::start(&opts(repo.path(), scouted.path())).unwrap();
    assert_eq!(
        agent_types(&scout),
        [None],
        "the scout runs on the default agent"
    );

    let out = tempfile::tempdir().unwrap();
    let (run, s) = small_run(repo.path(), out.path());
    assert_eq!(
        agent_types(&s),
        [Some("rust-reviewer"); 3],
        "every lens runs on the profile's lens agent, named without a host prefix"
    );
    let mut medium = finding("Medium", 2);
    medium["title"] = json!("another");
    let round1 = json!({
        "lens-rust-errors-r1": lens("errors", &[finding("High", 1), medium]),
        "lens-rust-intent-r1": lens("intent", &[]),
        "lens-rust-tests-r1": lens("tests", &[]),
    });
    let s = step::submit(&run, Some(&answers(round1))).unwrap();
    assert_eq!(ids(&s), ["dedup-rust"]);
    assert_eq!(
        agent_types(&s),
        [None],
        "the dedup runs on the default agent"
    );
    let dedup = json!({"dedup-rust": {"groups": []}});
    let s = step::submit(&run, Some(&answers(dedup))).unwrap();
    assert!(
        !ids(&s).is_empty() && ids(&s).iter().all(|id| id.starts_with("verify")),
        "{s}"
    );
    assert!(
        agent_types(&s).iter().all(Option::is_none),
        "the verifiers run on the default agent: {s}"
    );
}

#[test]
fn a_degraded_note_reaches_the_report_and_the_finished_step_once() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, _) = small_run(repo.path(), out.path());
    let note = "round 1: 3 task(s) on `craft:rust-reviewer` ran on the default agent type instead";
    let empty = json!({
        "lens-rust-errors-r1": lens("errors", &[]), "lens-rust-intent-r1": lens("intent", &[]), "lens-rust-tests-r1": lens("tests", &[]),
    });
    let notes = [note.to_owned(), format!("  {note}\n"), String::new()];
    let s = step::submit_noting(&run, Some(&answers(empty)), &notes).unwrap();
    assert_eq!(
        (s["verdict"].clone(), s["degraded"].clone()),
        (json!("Approve"), json!([note])),
        "the verdict stands; the note is kept once, trimmed, the blank one dropped: {s}"
    );
    let report = std::fs::read_to_string(state::report_path(&run)).unwrap();
    assert!(
        report.contains(&format!(
            "## Degraded\n\nThe host ran part of this review weaker than it asked:\n\n- {note}\n"
        )),
        "{report}"
    );
    assert!(
        report.find("## Degraded") < report.find("## Confirmed findings"),
        "named before the findings: {report}"
    );
}

#[test]
fn a_run_with_no_degraded_note_says_nothing_of_it() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, _) = small_run(repo.path(), out.path());
    let empty = json!({
        "lens-rust-errors-r1": lens("errors", &[]), "lens-rust-intent-r1": lens("intent", &[]), "lens-rust-tests-r1": lens("tests", &[]),
    });
    let s = step::submit(&run, Some(&answers(empty))).unwrap();
    assert!(s.get("degraded").is_none(), "{s}");
    let report = std::fs::read_to_string(state::report_path(&run)).unwrap();
    assert!(!report.contains("## Degraded"), "{report}");
    let saved = std::fs::read_to_string(state::state_path(&run)).unwrap();
    assert!(
        !saved.contains("\"degraded\""),
        "the state keeps its old shape: {saved}"
    );
}
