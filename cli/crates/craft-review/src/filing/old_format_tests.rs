//! A run whose state an earlier binary wrote, in a format this one refuses: its telemetry still
//! files what it holds, the refusal coming after (realm @nick/craft, node #618).

use serde_json::json;

use super::tests::{Fake, ctx, finished, pending};
use super::{WriteError, open, refile, unfinished};

/// A state of format 6 standing at `phase`, as a craft before 0.59.0 wrote it.
fn old_state(run: &std::path::Path, phase: &str) {
    let state = json!({"version": 6, "phase": phase});
    std::fs::write(run.join("state.json"), state.to_string()).unwrap();
}

#[test]
fn an_earlier_binarys_finished_run_whose_record_did_not_land_is_filed_again() {
    let run = tempfile::tempdir().unwrap();
    let w = Fake::answering(vec![
        ("checkpoint", Ok(json!({"runDir": "/store/.partial/a"}))),
        ("finalize", Err(WriteError::Store("disk full".into()))),
    ]);
    open(run.path(), ctx(), "", &finished(1), &w);
    old_state(run.path(), "done");
    let again = refile(run.path(), Vec::new(), &w).unwrap();
    assert_eq!(again["filing"]["record"], json!("filed"), "{again}");
}

#[test]
fn an_earlier_binarys_open_segment_is_filed_incomplete_with_the_refusal() {
    let run = tempfile::tempdir().unwrap();
    let w = Fake::default();
    open(run.path(), ctx(), "", &pending("lenses", 1), &w);
    old_state(run.path(), "lenses");
    let lost = unfinished(run.path(), "format 6", &w).unwrap();
    assert!(lost.is_empty(), "{lost:?}");
    let record = w.request(1);
    assert_eq!(
        (&record["step"]["verdict"], &record["step"]["notRun"]),
        (&json!("INCOMPLETE"), &json!(["format 6"])),
        "{record}"
    );
}
