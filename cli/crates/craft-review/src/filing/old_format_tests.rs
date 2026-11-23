//! A run whose state an earlier binary wrote, in a format this one refuses: its telemetry still
//! files again what it kept or lost, the refusal coming after (realm @nick/craft, node #618).

use serde_json::json;

use super::tests::{Fake, ctx, finished};
use super::{WriteError, open, refile, resuming};

/// A state of format 6 standing at `phase`, as a craft before 0.59.0 wrote it.
fn old_state(run: &std::path::Path, phase: &str) {
    let state = json!({"version": 6, "phase": phase});
    std::fs::write(run.join("state.json"), state.to_string()).unwrap();
}

#[test]
fn an_earlier_binarys_finished_run_whose_record_did_not_land_is_filed_again_once() {
    let run = tempfile::tempdir().unwrap();
    let w = Fake::answering(vec![
        ("checkpoint", Ok(json!({"runDir": "/store/.partial/a"}))),
        ("finalize", Err(WriteError::Store("disk full".into()))),
    ]);
    open(run.path(), ctx(), "", &finished(1), &w);
    old_state(run.path(), "done");
    // Read whatever its format, the state says the run finished: no stopped part to file.
    assert!(resuming(run.path(), &w).is_empty());
    assert_eq!(w.commands().len(), 2, "resuming filed nothing");
    let again = refile(run.path(), Vec::new(), &w).unwrap();
    assert_eq!(again["filing"]["record"], json!("filed"), "{again}");
    assert_eq!(w.commands().len(), 3, "the record filed once");
}

#[test]
fn an_earlier_binarys_stopped_part_whose_record_did_not_land_is_filed_again_on_resume() {
    let run = tempfile::tempdir().unwrap();
    let w = Fake::answering(vec![
        ("checkpoint", Ok(json!({"runDir": "/store/.partial/a"}))),
        ("finalize", Err(WriteError::Store("disk full".into()))),
    ]);
    let stopped = json!({"run": "/run", "done": true, "report": "/run/report.md", "verdict": "INCOMPLETE", "stopped": {"cause": "limit"}, "at": 1, "took": 1});
    open(run.path(), ctx(), "s1", &stopped, &w);
    // A stopped run's state is not done: read whatever its format, it is a part to file again.
    old_state(run.path(), "lenses");
    assert!(resuming(run.path(), &w).is_empty());
    let retried = w.request(2);
    assert_eq!(
        (&retried["retry"], &retried["step"]["verdict"]),
        (&json!(true), &json!("INCOMPLETE")),
        "{retried}"
    );
}
