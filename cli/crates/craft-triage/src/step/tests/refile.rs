//! A finished run whose record did not land filed again by `--resume`, once.

use std::cell::RefCell;

use craft_review::filing::{Call, WriteError, Writer};
use serde_json::{Value, json};

use super::{Unused, plan_of, run_case, run_recording};
use crate::TriageError;
use crate::run::Recording;
use crate::step::finished::plan_path;
use crate::step::{Said, submit};

/// Refuses its first write, answers every later one filed.
struct Flaky(RefCell<Vec<Value>>);

impl Writer for Flaky {
    fn write(&self, call: &Call<'_>) -> Result<Value, WriteError> {
        let mut calls = self.0.borrow_mut();
        calls.push(call.request.clone());
        if calls.len() == 1 {
            return Err(WriteError::Store("down".into()));
        }
        Ok(json!({"ok": true, "reason": "", "file": "/s/r.json"}))
    }
}

#[test]
fn a_finished_run_whose_record_did_not_land_files_it_again_on_a_resume_once() {
    let w = Flaky(RefCell::new(Vec::new()));
    let name = "carry-forward of a prior ledger";
    let (_, dir, step) = run_recording(name, &[], Some(Recording::default()), &w);
    assert_eq!(step["filing"]["record"], "failed", "{step}");
    let done = |e: Result<Value, TriageError>| matches!(e, Err(TriageError::Done(_)));
    assert!(
        done(submit(dir.path(), None, &Said::default(), &w)),
        "a plain submit is refused"
    );
    let resumed = Said {
        resume: true,
        ..Said::default()
    };
    let again = submit(dir.path(), None, &resumed, &w).unwrap();
    assert_eq!(
        again["filing"],
        json!({"record": "filed", "file": "/s/r.json", "lost": []})
    );
    let calls = w.0.borrow().clone();
    assert_eq!((calls.len(), &calls[1]["retry"]), (2, &json!(true)));
    assert_eq!(calls[1]["record"], calls[0]["record"], "the same record");
    let md = plan_of(&again)["plan_markdown"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(!md.contains("Telemetry lost"), "{md}");
    let on_disk: Value =
        serde_json::from_str(&std::fs::read_to_string(plan_path(dir.path())).unwrap()).unwrap();
    assert_eq!(on_disk["plan_markdown"], plan_of(&again)["plan_markdown"]);
    assert!(
        done(submit(dir.path(), None, &resumed, &w)),
        "a filed run is done"
    );
    let (_, plain, _) = run_case(name, &[]);
    assert!(
        done(submit(plain.path(), None, &resumed, &Unused)),
        "a run that does not record"
    );
}
