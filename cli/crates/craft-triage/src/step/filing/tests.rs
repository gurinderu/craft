//! The record filed once per attempt, sent again as a retry once an attempt is kept, and each
//! answer of the writer read into what the run says it lost.

use std::cell::RefCell;

use craft_review::filing::{Call, WriteError, Writer};
use craft_store::js::Js;
use serde_json::{Value, json};

use super::{Filed, answered, file, read};
use crate::run::{Args, Phase, Recording};
use crate::state::{STATE_VERSION, Seen, TriageState};

struct Asked(RefCell<Vec<Value>>);

impl Writer for Asked {
    fn write(&self, call: &Call<'_>) -> Result<Value, WriteError> {
        self.0.borrow_mut().push(call.request.clone());
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
    }
}

#[test]
fn a_run_that_finishes_again_sends_its_record_as_a_retry() {
    let d = tempfile::tempdir().unwrap();
    let w = Asked(RefCell::new(Vec::new()));
    let s = run(Some(Recording::default()));
    let record = Js::Obj(craft_store::js::Obj::new().with("name", Js::str("triage-findings")));
    for _ in 0..2 {
        file(d.path(), &s, &record, &w).unwrap();
    }
    let asked = w.0.borrow();
    let retries: Vec<&Value> = asked.iter().map(|r| &r["retry"]).collect();
    assert_eq!(retries, [&json!(false), &json!(true)]);
    assert_eq!(asked[0]["record"], json!({"name": "triage-findings"}));
    assert_eq!(asked[0]["repo"], "/repo");
    assert_eq!(read(d.path()).unwrap().record, "filed");
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
        answered(Ok(json!({"ok": false, "reason": "refused", "file": ""}))),
        filed("failed", "", &["the run record — refused"])
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
