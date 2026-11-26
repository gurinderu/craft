//! A run started recording files its record through the writer once it ends, before its plan is
//! built: what the writer was sent, what the step and the status say, and what leads the plan.

use std::cell::RefCell;

use craft_review::filing::{Call, WriteError, Writer};
use serde_json::{Value, json};

use super::{file, run_case, run_recording};
use crate::run::Recording;
use crate::step::finished::record_path;
use crate::step::status;

/// Answers each write with `answer`, keeping what it was asked.
struct Kept {
    answer: Result<Value, WriteError>,
    calls: RefCell<Vec<(String, String, Value)>>,
}

impl Writer for Kept {
    fn write(&self, call: &Call<'_>) -> Result<Value, WriteError> {
        let asked = (
            call.command.to_owned(),
            call.root.to_owned(),
            call.request.clone(),
        );
        self.calls.borrow_mut().push(asked);
        self.answer.clone()
    }
}

fn kept(answer: Result<Value, WriteError>) -> Kept {
    Kept {
        answer,
        calls: RefCell::new(Vec::new()),
    }
}

fn recording() -> Recording {
    Recording {
        root: "/plugin".into(),
        session: "s-1".into(),
    }
}

const CASE: &str = "carry-forward of a prior ledger";

#[test]
fn a_recording_run_files_its_record_once_as_built_and_names_it_in_the_step_and_the_status() {
    let w = kept(Ok(
        json!({"ok": true, "reason": "", "file": "/store/r.json"}),
    ));
    let (_, dir, step) = run_recording(CASE, &[], Some(recording()), &w);
    let calls = w.calls.borrow();
    let [(command, root, req)] = calls.as_slice() else {
        panic!("one write: {calls:?}")
    };
    assert_eq!((command.as_str(), root.as_str()), ("record", "/plugin"));
    let built: Value = serde_json::from_str(&file(&record_path(dir.path()))).unwrap();
    assert_eq!(req["record"], built);
    assert_eq!(
        (&req["retry"], &req["session"]),
        (&json!(false), &json!("s-1"))
    );
    assert!(req["repo"].as_str().is_some_and(|r| !r.is_empty()), "{req}");
    let filing = json!({"record": "filed", "file": "/store/r.json", "lost": []});
    assert_eq!(step["filing"], filing);
    assert_eq!(status(dir.path()).unwrap()["filing"], filing);
    assert!(
        step["plan"].get("telemetryLost").is_none(),
        "{}",
        step["plan"]
    );
}

#[test]
fn a_run_that_does_not_record_files_nothing_and_says_no_filing() {
    let (_, dir, step) = run_case(CASE, &[]);
    assert!(step.get("filing").is_none(), "{step}");
    assert!(status(dir.path()).unwrap().get("filing").is_none());
}

#[test]
fn a_record_that_did_not_land_leads_the_plan() {
    let w = kept(Err(WriteError::Store("disk full".into())));
    let (_, _, step) = run_recording(CASE, &[], Some(recording()), &w);
    let lost = "the run record — the run store refused the write: disk full";
    assert_eq!(
        step["filing"],
        json!({"record": "failed", "file": "", "lost": [lost]})
    );
    let plan = &step["plan"];
    let md = plan["plan_markdown"].as_str().unwrap();
    assert!(
        md.starts_with("## ⚠️ Telemetry lost\n1 record write(s)"),
        "{md}"
    );
    assert!(md.contains(&format!("- {lost}\n")), "{md}");
    assert_eq!(plan["telemetryLost"], json!([lost]));
}

#[test]
fn a_landed_record_the_store_warned_on_reads_incomplete_not_lost() {
    let w = kept(Ok(
        json!({"ok": true, "reason": "craft-log-run WARNING: x", "file": "/s/r.json"}),
    ));
    let (_, _, step) = run_recording(CASE, &[], Some(recording()), &w);
    assert_eq!(step["filing"]["record"], "filed");
    let md = step["plan"]["plan_markdown"].as_str().unwrap();
    assert!(md.starts_with("## ⚠️ Telemetry incomplete\n"), "{md}");
}

#[test]
fn a_failed_plan_is_led_by_the_record_that_did_not_land() {
    let w = kept(Ok(json!({"ok": false, "reason": "", "file": ""})));
    let (_, _, step) = run_recording("class 1 without a prBase", &[], Some(recording()), &w);
    let plan = step["plan"].as_str().unwrap();
    let lost =
        "- the run record — the writer gave no reason\n\nTriage failed: the Plan-phase agent";
    assert!(plan.starts_with("## ⚠️ Telemetry lost\n"), "{plan}");
    assert!(plan.contains(lost), "{plan}");
}

#[test]
fn a_recording_run_lands_its_record_in_the_run_store() {
    let store = tempfile::tempdir().unwrap();
    let w = craft_review::filing::StoreWriter {
        store: Some(store.path().to_path_buf()),
    };
    let (_, dir, step) = run_recording(CASE, &[], Some(recording()), &w);
    assert_eq!(step["filing"]["record"], "filed", "{step}");
    let landed = step["filing"]["file"].as_str().unwrap();
    assert!(
        landed.starts_with(&store.path().display().to_string()),
        "{landed}"
    );
    let detail: Value = serde_json::from_str(&file(std::path::Path::new(landed))).unwrap();
    let built: Value = serde_json::from_str(&file(&record_path(dir.path()))).unwrap();
    assert_eq!(
        (&detail["name"], &detail["triage"]),
        (&built["name"], &built["triage"])
    );
    assert!(
        detail["ts"].is_string() && detail["engineRevision"].is_number(),
        "{detail}"
    );
    let index = file(&store.path().join("index.jsonl"));
    assert_eq!(index.lines().count(), 1, "{index}");
    assert!(index.contains("\"name\":\"triage-findings\""), "{index}");
}
