use std::cell::RefCell;
use std::collections::VecDeque;

use serde_json::{Value, json};

use super::*;

/// A writer that keeps every call and answers from a script, per command, in order; one with no
/// answer left lands (a checkpoint into `/store/.partial/a`, the record filed).
#[derive(Default)]
struct Fake {
    calls: RefCell<Vec<(String, Value)>>,
    answers: RefCell<VecDeque<(&'static str, Result<Value, WriteError>)>>,
}

impl Fake {
    fn answering(script: Vec<(&'static str, Result<Value, WriteError>)>) -> Self {
        Self {
            answers: RefCell::new(script.into()),
            ..Self::default()
        }
    }

    fn commands(&self) -> Vec<String> {
        self.calls.borrow().iter().map(|(c, _)| c.clone()).collect()
    }

    fn request(&self, i: usize) -> Value {
        self.calls.borrow()[i].1.clone()
    }
}

impl Writer for Fake {
    fn write(&self, call: &Call<'_>) -> Result<Value, WriteError> {
        self.calls
            .borrow_mut()
            .push((call.command.to_owned(), call.request.clone()));
        let mut answers = self.answers.borrow_mut();
        if answers.front().is_some_and(|(c, _)| *c == call.command) {
            return answers.pop_front().map_or(Ok(Value::Null), |(_, a)| a);
        }
        Ok(match call.command {
            "checkpoint" => json!({"phase": "x", "runDir": "/store/.partial/a"}),
            _ => json!({"ok": true, "reason": ""}),
        })
    }
}

fn ctx() -> Ctx {
    Ctx {
        repo: "/r".into(),
        head: "abc".into(),
        depth: "full".into(),
        strict: true,
        root: Some("/plugin".into()),
        craft_version: "0.44.0".into(),
        via: "rust-audit".into(),
    }
}

fn pending(phase: &str, at: u64) -> Value {
    json!({"run": "/run", "done": false, "tasks": [], "phase": phase, "at": at, "took": 5})
}

fn finished(at: u64) -> Value {
    json!({"run": "/run", "done": true, "report": "/run/report.md", "verdict": "Approve", "at": at, "took": 5})
}

fn host(agents: u64) -> Host {
    Host {
        agents: Some(agents),
        output_tokens: Some(9000),
        ..Host::default()
    }
}

#[test]
fn the_start_writes_its_checkpoint_and_keeps_the_directory_it_landed_in() {
    let run = tempfile::tempdir().unwrap();
    let w = Fake::default();
    let said = open(run.path(), ctx(), "s1", &pending("scout", 1), &w);
    assert_eq!(
        said,
        json!({"runDir": "/store/.partial/a", "rejoin": false, "lost": []})
    );
    assert_eq!(w.commands(), ["checkpoint"]);
    let req = w.request(0);
    assert_eq!(
        (
            req["start"].clone(),
            req["session"].clone(),
            req["dir"].clone()
        ),
        (json!(true), json!("s1"), json!(""))
    );
}

#[test]
fn only_a_submit_that_ends_a_phase_writes_that_phases_checkpoint() {
    let run = tempfile::tempdir().unwrap();
    let w = Fake::default();
    open(run.path(), ctx(), "", &pending("lenses", 1), &w);
    submitted(run.path(), &pending("lenses", 2), &host(2), &w).unwrap();
    assert_eq!(
        w.commands(),
        ["checkpoint"],
        "a step in the same phase writes nothing"
    );
    let said = submitted(run.path(), &pending("verify", 3), &host(3), &w).unwrap();
    assert_eq!(said["lost"], json!([]));
    assert_eq!(w.commands(), ["checkpoint", "checkpoint"]);
    let req = w.request(1);
    assert_eq!(
        (req["start"].clone(), req["dir"].clone()),
        (json!(false), json!("/store/.partial/a"))
    );
    let agents: Vec<u64> = req["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["agents"].as_u64().unwrap())
        .collect();
    assert_eq!(
        agents,
        [0, 2, 3],
        "each step kept with the task agents the host had dispatched by then"
    );
}

#[test]
fn the_finishing_submit_writes_the_last_checkpoint_then_the_record_once() {
    let run = tempfile::tempdir().unwrap();
    let w = Fake::default();
    open(run.path(), ctx(), "", &pending("verify", 1), &w);
    let said = submitted(run.path(), &finished(2), &host(4), &w).unwrap();
    assert_eq!(said["record"], json!("filed"));
    assert_eq!(w.commands(), ["checkpoint", "checkpoint", "finalize"]);
    let req = w.request(2);
    assert_eq!(req["step"]["verdict"], json!("Approve"));
    let fields = [
        &req["depth"],
        &req["strict"],
        &req["via"],
        &req["outputTokens"],
        &req["retry"],
        &req["dir"],
    ];
    assert_eq!(
        fields,
        [
            &json!("full"),
            &json!(true),
            &json!("rust-audit"),
            &json!(9000),
            &json!(false),
            &json!("/store/.partial/a")
        ]
    );
    assert_eq!(
        file_again(run.path(), &w),
        None,
        "a filed record is not filed again"
    );
}

#[test]
fn a_failed_checkpoint_is_said_and_every_later_write_rejoins_the_segments_directory() {
    let run = tempfile::tempdir().unwrap();
    let w = Fake::answering(vec![(
        "checkpoint",
        Ok(json!({"phase": "start", "error": "craft-log-run FAILED: disk full"})),
    )]);
    let said = open(run.path(), ctx(), "", &pending("verify", 1), &w);
    assert_eq!(
        said["lost"],
        json!(["phase checkpoint 'start' — craft-log-run FAILED: disk full"])
    );
    submitted(run.path(), &finished(2), &host(1), &w).unwrap();
    assert_eq!(
        (
            w.request(1)["rejoin"].clone(),
            w.request(2)["rejoin"].clone()
        ),
        (json!(true), json!(true))
    );
}

#[test]
fn a_record_that_does_not_land_never_fails_the_step_and_is_filed_again_as_a_retry() {
    let run = tempfile::tempdir().unwrap();
    let w = Fake::answering(vec![
        ("checkpoint", Ok(json!({"runDir": "/store/.partial/a"}))),
        ("finalize", Err(WriteError::NoNode)),
    ]);
    let said = open(run.path(), ctx(), "", &finished(1), &w);
    assert_eq!(said["record"], json!("failed"));
    assert_eq!(
        said["lost"],
        json!(["the run record — node is not on the PATH"])
    );
    let again = file_again(run.path(), &w).unwrap();
    assert_eq!(
        (again["verdict"].clone(), again["filing"]["record"].clone()),
        (json!("Approve"), json!("filed"))
    );
    let (first, retried) = (w.request(1), w.request(2));
    assert_eq!(
        (first["retry"].clone(), retried["retry"].clone()),
        (json!(false), json!(true))
    );
    assert_eq!(first["step"], retried["step"], "the same record sent again");
    assert_eq!(file_again(run.path(), &w), None);
}

#[test]
fn a_record_that_landed_with_a_warning_is_filed_and_the_warning_said() {
    let run = tempfile::tempdir().unwrap();
    let warned =
        json!({"ok": true, "reason": "craft-log-run WARNING: the run directory could not be read"});
    let w = Fake::answering(vec![
        ("checkpoint", Ok(json!({"runDir": "/d"}))),
        ("finalize", Ok(warned)),
    ]);
    let said = open(run.path(), ctx(), "", &finished(1), &w);
    assert_eq!(said["record"], json!("filed"));
    assert_eq!(
        said["lost"],
        json!([
            "the run directory (the record itself landed) — craft-log-run WARNING: the run directory could not be read"
        ])
    );
}

#[test]
fn a_run_with_no_plugin_root_says_its_writes_are_lost() {
    let run = tempfile::tempdir().unwrap();
    let w = Fake::default();
    let said = open(
        run.path(),
        Ctx {
            root: None,
            ..ctx()
        },
        "",
        &finished(1),
        &w,
    );
    assert!(w.commands().is_empty());
    assert_eq!(said["record"], json!("failed"));
    assert_eq!(
        said["lost"][1],
        json!(
            "the run record — no craft plugin root is known to the run, so the record writer cannot be found"
        )
    );
}

#[test]
fn a_resume_files_a_new_segment_from_its_own_start_checkpoint() {
    let run = tempfile::tempdir().unwrap();
    let w = Fake::default();
    open(run.path(), ctx(), "s1", &pending("lenses", 1), &w);
    let resumed = Host {
        agents: Some(0),
        resume: true,
        session: "s2".into(),
        ..Host::default()
    };
    submitted(run.path(), &pending("verify", 9), &resumed, &w).unwrap();
    let req = w.request(1);
    assert_eq!(
        (
            req["start"].clone(),
            req["dir"].clone(),
            req["session"].clone()
        ),
        (json!(true), json!(""), json!("s2"))
    );
    assert_eq!(
        req["steps"].as_array().map(Vec::len),
        Some(1),
        "the earlier segment's steps are not this one's"
    );
}

#[test]
fn a_run_that_files_nothing_is_left_alone() {
    let run = tempfile::tempdir().unwrap();
    let w = Fake::default();
    assert_eq!(submitted(run.path(), &finished(1), &host(1), &w), None);
    assert_eq!(file_again(run.path(), &w), None);
    assert_eq!(
        refile(run.path(), &w),
        None,
        "nor is a run with no finished state re-filed"
    );
    assert!(w.commands().is_empty());
}
