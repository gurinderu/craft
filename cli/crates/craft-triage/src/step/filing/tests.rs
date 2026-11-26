//! The record filed once per attempt, sent again as a retry once an attempt is kept, and each
//! answer of the writer read into what the run says it lost.

use std::cell::RefCell;

use craft_review::filing::{Call, WriteError, Writer};
use craft_store::js::Js;
use serde_json::{Value, json};

use super::{Filed, answered, file, read};
use crate::run::{Args, Phase, Recording};
use crate::state::{STATE_VERSION, Seen, TriageState};

/// Keeps each request, and what the run said of its filing while the write was out.
struct Asked(RefCell<Vec<Value>>);

impl Writer for Asked {
    fn write(&self, call: &Call<'_>) -> Result<Value, WriteError> {
        let during = read(call.run).map(|f| f.record).unwrap_or_default();
        let mut req = call.request.clone();
        req["during"] = Value::String(during);
        self.0.borrow_mut().push(req);
        Ok(json!({"ok": true, "reason": "", "file": "/s/r.json"}))
    }
}

fn run(record: Option<Recording>) -> TriageState {
    TriageState {
        version: STATE_VERSION,
        cwd: "/repo".into(),
        args: Args {
            record,
            ..Args::default()
        },
        phase: Phase::Done,
        tasks: Vec::new(),
        seen: Seen::default(),
        degraded: Vec::new(),
        notes: Vec::new(),
        stopped: None,
    }
}

fn rec() -> Js {
    Js::Obj(craft_store::js::Obj::new().with("name", Js::str("triage-findings")))
}

#[test]
fn a_first_filing_marks_its_attempt_and_sends_the_record_as_built() {
    let d = tempfile::tempdir().unwrap();
    let w = Asked(RefCell::new(Vec::new()));
    file(d.path(), &run(Some(Recording::default())), &rec(), &w).unwrap();
    let asked = w.0.borrow();
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0]["record"], json!({"name": "triage-findings"}));
    assert_eq!(
        (&asked[0]["repo"], &asked[0]["retry"]),
        (&json!("/repo"), &json!(false))
    );
    assert_eq!(asked[0]["during"], "attempted");
    assert_eq!(read(d.path()).unwrap().record, "filed");
}

#[test]
fn a_run_whose_filing_is_kept_filed_files_nothing_more() {
    let d = tempfile::tempdir().unwrap();
    let w = Asked(RefCell::new(Vec::new()));
    let s = run(Some(Recording::default()));
    let first = file(d.path(), &s, &rec(), &w).unwrap();
    let again = file(d.path(), &s, &rec(), &w).unwrap();
    assert_eq!(w.0.borrow().len(), 1, "one write");
    assert_eq!(again, first);
}

#[test]
fn an_attempt_that_never_answered_goes_out_again_as_a_retry() {
    let s = run(Some(Recording::default()));
    for left in [
        "{\"record\": \"attempted\"}\n",
        "{\"rec",
        "{\"record\": \"failed\"}\n",
    ] {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(super::filing_path(d.path()), left).unwrap();
        let w = Asked(RefCell::new(Vec::new()));
        file(d.path(), &s, &rec(), &w).unwrap();
        assert_eq!(w.0.borrow()[0]["retry"], json!(true), "{left}");
    }
}

#[test]
fn a_run_that_does_not_record_sends_nothing_and_keeps_nothing() {
    let d = tempfile::tempdir().unwrap();
    let w = Asked(RefCell::new(Vec::new()));
    assert_eq!(file(d.path(), &run(None), &Js::Null, &w).unwrap(), None);
    assert!(w.0.borrow().is_empty());
    assert!(read(d.path()).is_none());
}

#[test]
fn each_answer_of_the_writer_is_read_into_what_the_run_lost() {
    let filed = |record: &str, file: &str, lost: &[&str]| Filed {
        record: record.into(),
        file: file.into(),
        lost: lost.iter().map(|l| (*l).to_owned()).collect(),
    };
    assert_eq!(
        answered(Ok(json!({"ok": true, "reason": "", "file": "/f.json"}))),
        filed("filed", "/f.json", &[])
    );
    assert_eq!(
        answered(Ok(json!({"ok": true, "reason": "w", "file": "/f.json"}))),
        filed(
            "filed",
            "/f.json",
            &["the run directory (the record itself landed) — w"]
        )
    );
    assert_eq!(
        answered(Ok(
            json!({"ok": false, "reason": "refused", "file": "/f.json"})
        )),
        filed("failed", "/f.json", &["the run record — refused"])
    );
    assert_eq!(
        answered(Ok(json!({"reason": ""}))),
        filed(
            "failed",
            "",
            &["the run record — the writer gave no reason"]
        )
    );
    assert_eq!(
        answered(Err(WriteError::NoStore)).lost[0],
        format!("the run record — {}", WriteError::NoStore)
    );
}
