use std::path::Path;

use serde_json::{Value, json};

use super::*;
use crate::state::{self, RunState, STATE_VERSION};

/// A writer that lands every checkpoint and answers the record from `record`.
struct Answering(Result<Value, WriteError>);

impl Writer for Answering {
    fn write(&self, call: &Call<'_>) -> Result<Value, WriteError> {
        match call.command {
            "checkpoint" => Ok(json!({"phase": "x", "runDir": "/store/.partial/a"})),
            _ => self.0.clone(),
        }
    }
}

fn lands() -> Answering {
    Answering(Ok(
        json!({"ok": true, "reason": "", "file": "/store/r.json"}),
    ))
}

/// A run in `phase` kept in `dir`, its report written when it is done.
fn kept_run(dir: &Path, phase: &str) {
    let run: RunState = serde_json::from_value(json!({
        "version": STATE_VERSION,
        "context": {"repo": "/r", "base": "origin/main", "spec": "", "craftRoot": null, "craftVersion": null},
        "diff": {"base": "origin/main", "mergeBase": "abc", "head": "def", "dirty": false,
                 "files": [], "stat": "", "log": ""},
        "tracks": [], "uncovered": [], "light": false, "phase": phase, "tasks": [],
        "rounds": {"round": 1, "pool": [], "yields": [], "expected": [], "returned": [], "failures": {}},
        "findings": [], "settled": [], "notes": [], "notRun": [],
        "degraded": ["a lens ran on the default agent"], "verdict": "Approve"
    }))
    .unwrap();
    state::save(dir, &run).unwrap();
    if phase == "done" {
        std::fs::write(state::report_path(dir), "# craft review\n").unwrap();
    }
}

fn ctx(root: Option<&str>) -> Ctx {
    Ctx {
        repo: "/r".into(),
        root: root.map(str::to_owned),
        craft_version: "0.54.1".into(),
        ..Ctx::default()
    }
}

fn finished(run: &Path) -> Value {
    json!({"run": run.display().to_string(), "done": true, "report": "/run/report.md",
           "verdict": "Approve", "degraded": ["a lens ran on the default agent"]})
}

fn degraded(run: &Path) -> Vec<String> {
    state::load(run).unwrap().degraded
}

fn report(run: &Path) -> String {
    std::fs::read_to_string(state::report_path(run)).unwrap()
}

fn fails() -> Answering {
    Answering(Err(WriteError::Store("disk full".into())))
}

#[test]
fn a_run_started_with_no_root_files_its_record_all_the_same() {
    let run = tempfile::tempdir().unwrap();
    kept_run(run.path(), "done");
    let said = open(run.path(), ctx(None), "", &finished(run.path()), &lands());
    assert_eq!(said["record"], json!("filed"), "{said}");
    assert_eq!(degraded(run.path()), ["a lens ran on the default agent"]);
}

#[test]
fn a_finished_run_whose_record_failed_says_so_in_its_step_its_report_and_its_state() {
    let run = tempfile::tempdir().unwrap();
    kept_run(run.path(), "done");
    let step = finished(run.path());
    let said = open(run.path(), ctx(Some("/plugin")), "", &step, &fails());
    let told = with_filing(step, said);
    let notes = told["degraded"].as_array().unwrap();
    assert_eq!(notes.len(), 2, "{told}");
    let note = notes[1].as_str().unwrap();
    assert!(
        note.starts_with(
            "the run record is not filed — the run store refused the write: disk full"
        ),
        "{note}"
    );
    assert!(note.contains("craft review submit --run '"), "{note}");
    assert!(note.contains("' --resume"), "{note}");
    assert_eq!(degraded(run.path())[1], note);
    let report = report(run.path());
    assert!(report.contains("## Degraded"), "{report}");
    assert!(report.contains(note), "{report}");
}

#[test]
fn a_record_filed_again_takes_its_note_back_from_the_step_the_state_and_the_report() {
    let run = tempfile::tempdir().unwrap();
    kept_run(run.path(), "done");
    open(run.path(), ctx(None), "", &finished(run.path()), &fails());
    assert_eq!(degraded(run.path()).len(), 2);
    let again = file_again(run.path(), Vec::new(), &lands()).unwrap();
    assert_eq!(again["filing"]["record"], json!("filed"));
    assert_eq!(
        again["degraded"],
        json!(["a lens ran on the default agent"]),
        "{again}"
    );
    assert_eq!(degraded(run.path()), ["a lens ran on the default agent"]);
    assert!(!report(run.path()).contains("the run record is not filed"));
}

#[test]
fn a_run_with_no_state_still_says_its_record_did_not_land_in_its_step() {
    let run = tempfile::tempdir().unwrap();
    let step = finished(run.path());
    let said = open(run.path(), ctx(None), "", &step, &fails());
    let told = with_filing(step, said);
    assert!(
        told["degraded"][1]
            .as_str()
            .unwrap()
            .starts_with("the run record is not filed — the run store refused the write"),
        "{told}"
    );
}
