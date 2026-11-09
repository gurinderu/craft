use std::cell::RefCell;
use std::collections::VecDeque;

use serde_json::{Value, json};

use super::*;

/// A writer that answers as the adapter does — a checkpoint after a step that ended no phase is
/// skipped, and not kept, unless the script has the writer unreached — and keeps every other call, answering from a script per command, in
/// order; one with no answer left lands (a checkpoint into `/store/.partial/a`, the record filed
/// into `/store/r.json`).
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

/// Whether the adapter's clock replay finds a phase the last of `steps` ended.
fn phase_ended(request: &Value) -> bool {
    let steps = request["steps"].as_array().unwrap();
    let [.., before, now] = steps.as_slice() else {
        return false;
    };
    before["done"] == false
        && before["phase"] != ""
        && (now["done"] == true || now["phase"] != before["phase"])
}

impl Writer for Fake {
    fn write(&self, call: &Call<'_>) -> Result<Value, WriteError> {
        let mut answers = self.answers.borrow_mut();
        // An unreached writer never gets to replay the clock: its failure comes first.
        let unreached = answers
            .front()
            .is_some_and(|(c, a)| *c == call.command && a.is_err());
        if !unreached
            && call.command == "checkpoint"
            && call.request["start"] == false
            && !phase_ended(call.request)
        {
            return Ok(json!({"skipped": true}));
        }
        self.calls
            .borrow_mut()
            .push((call.command.to_owned(), call.request.clone()));
        if answers.front().is_some_and(|(c, _)| *c == call.command) {
            return answers.pop_front().map_or(Ok(Value::Null), |(_, a)| a);
        }
        Ok(match call.command {
            "checkpoint" => json!({"phase": "x", "runDir": "/store/.partial/a"}),
            _ => json!({"ok": true, "reason": "", "file": "/store/r.json"}),
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
        ..Ctx::default()
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
    submitted(run.path(), &pending("lenses", 2), &host(2), Vec::new(), &w).unwrap();
    assert_eq!(
        w.commands(),
        ["checkpoint"],
        "a step in the same phase writes nothing"
    );
    let said = submitted(run.path(), &pending("verify", 3), &host(3), Vec::new(), &w).unwrap();
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
    let said = submitted(run.path(), &finished(2), &host(4), Vec::new(), &w).unwrap();
    assert_eq!(said["record"], json!("filed"));
    assert_eq!(
        said["recordFile"],
        json!("/store/r.json"),
        "the file the run's cost is enriched into"
    );
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
        file_again(run.path(), Vec::new(), &w),
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
    submitted(run.path(), &finished(2), &host(1), Vec::new(), &w).unwrap();
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
    let again = file_again(run.path(), Vec::new(), &w).unwrap();
    assert_eq!(
        (again["verdict"].clone(), again["filing"]["record"].clone()),
        (json!("Approve"), json!("filed"))
    );
    assert_eq!(
        (
            again["filing"]["refiledFile"].clone(),
            again["filing"].get("recordFile")
        ),
        (json!("/store/r.json"), None),
        "a re-file names its file apart from a filing of its own work"
    );
    let (first, retried) = (w.request(1), w.request(2));
    assert_eq!(
        (first["retry"].clone(), retried["retry"].clone()),
        (json!(false), json!(true))
    );
    assert_eq!(first["step"], retried["step"], "the same record sent again");
    assert_eq!(file_again(run.path(), Vec::new(), &w), None);
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
    submitted(run.path(), &pending("verify", 9), &resumed, Vec::new(), &w).unwrap();
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
    assert_eq!(
        submitted(run.path(), &finished(1), &host(1), Vec::new(), &w),
        None
    );
    assert_eq!(file_again(run.path(), Vec::new(), &w), None);
    assert_eq!(
        refile(run.path(), Vec::new(), &w),
        None,
        "nor is a run with no finished state re-filed"
    );
    assert!(w.commands().is_empty());
}

/// A stopped segment whose record failed, opened under `w`.
fn stopped_unfiled(run: &std::path::Path, w: &Fake) {
    let stopped = json!({"run": "/run", "done": true, "report": "/run/report.md", "verdict": "INCOMPLETE", "stopped": {"cause": "limit"}, "at": 1, "took": 1});
    assert_eq!(
        open(run, ctx(), "s1", &stopped, w)["record"],
        json!("failed")
    );
}

#[test]
fn a_stopped_parts_record_is_kept_and_filed_again_on_every_resume_until_it_lands() {
    let run = tempfile::tempdir().unwrap();
    let w = Fake::answering(vec![
        ("checkpoint", Ok(json!({"runDir": "/store/.partial/a"}))),
        ("finalize", Err(WriteError::NoNode)),
        ("finalize", Err(WriteError::NoNode)),
        ("finalize", Err(WriteError::NoNode)),
    ]);
    stopped_unfiled(run.path(), &w);
    for _ in 0..2 {
        let said = resuming(run.path(), &w);
        assert_eq!(
            said[0],
            "the record of a stopped part of this run — node is not on the PATH"
        );
        assert!(
            said[1].starts_with(
                "1 stopped part(s) of this run still have no record — resume the run again"
            ),
            "{said:?}"
        );
    }
    assert_eq!(summary(run.path()).unwrap()["pending"], json!(1));
    let said = resuming(run.path(), &w);
    assert!(said.is_empty(), "{said:?}");
    assert_eq!(summary(run.path()).unwrap()["pending"], json!(0));
    let finals: Vec<Value> = (1..5).map(|i| w.request(i)).collect();
    assert_eq!(
        finals
            .iter()
            .map(|r| r["retry"].clone())
            .collect::<Vec<_>>(),
        [json!(false), json!(true), json!(true), json!(true)]
    );
    assert!(
        finals
            .iter()
            .all(|r| r["step"] == finals[0]["step"] && r["dir"] == finals[0]["dir"]),
        "the stopped part's record, byte for byte"
    );
    let resumed = Host {
        agents: Some(0),
        resume: true,
        session: "s2".into(),
        ..Host::default()
    };
    submitted(run.path(), &pending("lenses", 9), &resumed, Vec::new(), &w).unwrap();
    assert_eq!(
        w.request(5)["start"],
        json!(true),
        "the new segment's own start"
    );
}

#[test]
fn an_unreached_writer_says_a_lost_checkpoint_only_for_a_step_that_may_have_ended_a_phase() {
    let run = tempfile::tempdir().unwrap();
    let w = Fake::default();
    open(run.path(), ctx(), "", &pending("lenses", 1), &w);
    let down = Fake::answering(vec![
        ("checkpoint", Err(WriteError::NoNode)),
        ("checkpoint", Err(WriteError::NoNode)),
    ]);
    let same = submitted(
        run.path(),
        &pending("lenses", 2),
        &host(1),
        Vec::new(),
        &down,
    )
    .unwrap();
    assert_eq!(same["lost"], json!([]), "no phase ended: nothing lost");
    let moved = submitted(
        run.path(),
        &pending("verify", 3),
        &host(2),
        Vec::new(),
        &down,
    )
    .unwrap();
    assert_eq!(
        moved["lost"],
        json!(["phase checkpoint 'lenses' — node is not on the PATH"])
    );
}

#[test]
fn the_summary_carries_why_the_record_did_not_land() {
    let run = tempfile::tempdir().unwrap();
    let w = Fake::answering(vec![
        ("checkpoint", Ok(json!({"runDir": "/d"}))),
        ("finalize", Err(WriteError::NoNode)),
    ]);
    open(run.path(), ctx(), "", &finished(1), &w);
    let s = summary(run.path()).unwrap();
    assert_eq!(
        s["finished"]["filing"]["lost"],
        json!(["the run record — node is not on the PATH"])
    );
}

#[test]
fn a_segment_that_ended_files_nothing_more_until_it_is_resumed() {
    let run = tempfile::tempdir().unwrap();
    let w = Fake::default();
    open(run.path(), ctx(), "", &finished(1), &w);
    let again = submitted(run.path(), &finished(2), &host(1), Vec::new(), &w).unwrap();
    assert_eq!(again["record"], json!("filed"));
    assert_eq!(
        w.commands(),
        ["checkpoint", "finalize"],
        "no second record for the same segment"
    );
}

#[test]
fn the_summary_names_the_record_and_the_step_the_segment_ended_with() {
    let run = tempfile::tempdir().unwrap();
    let w = Fake::default();
    assert_eq!(summary(run.path()), None);
    open(run.path(), ctx(), "", &finished(1), &w);
    let s = summary(run.path()).unwrap();
    assert_eq!(
        (s["record"].clone(), s["recordFile"].clone()),
        (json!("filed"), json!("/store/r.json"))
    );
    assert_eq!(s["finished"]["verdict"], json!("Approve"));
    assert_eq!(s["finished"]["filing"]["record"], json!("filed"));
}

#[test]
fn a_resume_whose_first_step_finishes_its_new_segment_names_its_own_record() {
    let run = tempfile::tempdir().unwrap();
    let w = Fake::default();
    open(run.path(), ctx(), "s1", &pending("lenses", 1), &w);
    let resumed = Host {
        agents: Some(0),
        resume: true,
        session: "s2".into(),
        ..Host::default()
    };
    let said = submitted(run.path(), &finished(9), &resumed, Vec::new(), &w).unwrap();
    assert_eq!(
        (said["recordFile"].clone(), said.get("refiledFile")),
        (json!("/store/r.json"), None)
    );
}

/// A run opened and finished through `w`, its record filed or not as the script says.
fn finished_run(w: &Fake) -> tempfile::TempDir {
    let run = tempfile::tempdir().unwrap();
    open(run.path(), ctx(), "s1", &pending("scout", 1), w);
    submitted(run.path(), &finished(9), &host(3), Vec::new(), w).unwrap();
    run
}

fn published() -> Value {
    let mut step = finished(20);
    step["prComments"] = json!({"pr": 7, "posted": 1});
    step["sorting"] = json!({"defect": 1, "doubtful": 0, "findings": []});
    step
}

#[test]
fn a_publication_after_the_fact_amends_the_filed_record_and_claims_no_cost() {
    let w = Fake::default();
    let run = finished_run(&w);
    let said = republished(run.path(), &published(), &w).unwrap();
    assert_eq!(w.commands().last().unwrap(), "publication");
    let req = w.request(w.commands().len() - 1);
    assert_eq!(
        (&req["recordFile"], &req["step"]["prComments"]["posted"]),
        (&json!("/store/r.json"), &json!(1))
    );
    assert_eq!(
        (&said["lost"], &said["refiledFile"], &said["recordFile"]),
        (&json!([]), &json!("/store/r.json"), &Value::Null),
        "{said}"
    );
    let kept = kept::load(run.path()).unwrap();
    assert_eq!(kept.finished.unwrap()["prComments"]["pr"], json!(7));
}

#[test]
fn a_publication_over_a_record_that_never_landed_files_it_as_first_sent_then_amends_it() {
    let w = Fake::answering(vec![(
        "finalize",
        Ok(json!({"ok": false, "reason": "store unwritable", "file": ""})),
    )]);
    let run = finished_run(&w);
    let said = republished(run.path(), &published(), &w).unwrap();
    let n = w.commands().len();
    assert_eq!(w.commands()[n - 2..], ["finalize", "publication"]);
    let refile = w.request(n - 2);
    // The payload the first attempt sent, so the store's proof knows an attempt that did land.
    assert_eq!(
        (
            &refile["retry"],
            &refile["step"],
            &refile["step"].get("prComments")
        ),
        (&json!(true), &finished(9), &None)
    );
    assert_eq!(w.request(n - 1)["recordFile"], json!("/store/r.json"));
    assert_eq!(
        (&said["record"], &said["lost"]),
        (&json!("filed"), &json!([])),
        "{said}"
    );
}

#[test]
fn a_publication_whose_record_still_does_not_land_is_said_and_keeps_the_first_payload() {
    let failed = || Ok(json!({"ok": false, "reason": "store unwritable", "file": ""}));
    let w = Fake::answering(vec![("finalize", failed()), ("finalize", failed())]);
    let run = finished_run(&w);
    let said = republished(run.path(), &published(), &w).unwrap();
    assert!(!w.commands().contains(&"publication".to_owned()));
    let lost = said["lost"].to_string();
    assert!(
        lost.contains("the publication in the run record — the record itself is not filed"),
        "{lost}"
    );
    assert_eq!(
        kept::load(run.path()).unwrap().finished,
        Some(finished(9)),
        "a later re-file sends what the first did"
    );
}

#[test]
fn a_publication_that_does_not_land_is_said_and_a_run_filing_nothing_files_nothing() {
    let w = Fake::answering(vec![(
        "publication",
        Ok(json!({"ok": false, "reason": "record not readable", "file": ""})),
    )]);
    let run = finished_run(&w);
    let said = republished(run.path(), &published(), &w).unwrap();
    assert_eq!(
        said["lost"],
        json!(["the publication in the run record — record not readable"])
    );
    let bare = tempfile::tempdir().unwrap();
    assert_eq!(republished(bare.path(), &published(), &w), None);
}

#[test]
fn reviewer_choices_a_publication_dropped_are_said() {
    let w = Fake::answering(vec![(
        "publication",
        Ok(
            json!({"ok": true, "reason": "dropped the choices of doubtful findings no longer listed: 3 (outside @ c.rs:1): defect", "file": "/store/r.json"}),
        ),
    )]);
    let run = finished_run(&w);
    let said = republished(run.path(), &published(), &w).unwrap();
    assert_eq!(
        said["lost"],
        json!([
            "the reviewer's sorting choices (the publication itself landed) — dropped the choices of doubtful findings no longer listed: 3 (outside @ c.rs:1): defect"
        ])
    );
}
