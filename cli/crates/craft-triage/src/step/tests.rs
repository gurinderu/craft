//! The triage driven on the step protocol end to end: a parity case's answers handed in as the
//! host would hand them, the finished run's plan and record as the engine wrote them.

use std::path::Path;

use craft_store::js::Js;
use serde_json::{Map, Value};

use super::{StartOptions, start, status, submit};
use crate::TriageError;
use crate::field::At;
use crate::parity::answers::{CaseAnswers, args_of};
use crate::parity::cases;
use crate::run::Answers;
use crate::state;
use crate::step::finished::{plan_path, record_path};

fn case(name: &str) -> Js {
    cases()
        .into_iter()
        .find(|c| c.at("name").as_str() == Some(name))
        .unwrap_or_else(|| panic!("no case {name}"))
}

fn git_repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let ok = std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(d.path())
        .status()
        .unwrap();
    assert!(ok.success());
    d
}

/// The answers to the run's pending tasks, as the case scripts them; a task whose agent the case
/// has die gets none, and fails once its retries are spent.
fn answers(dir: &Path, a: &CaseAnswers<'_>) -> Map<String, Value> {
    let s = state::load(dir).unwrap();
    s.tasks
        .iter()
        .filter(|t| t.pending())
        .filter_map(|t| {
            let given = a.answer(&t.kind).flatten()?;
            Some((t.id.clone(), Value::try_from(&given).unwrap()))
        })
        .collect()
}

/// Runs `name` to its end, the answers handed in by task id.
fn run_case(name: &str) -> (Js, tempfile::TempDir) {
    let c = case(name);
    let (repo, dir) = (git_repo(), tempfile::tempdir().unwrap());
    let a = CaseAnswers::new(&c, None);
    let opts = StartOptions {
        cwd: repo.path().into(),
        run_dir: dir.path().into(),
        args: args_of(&c),
    };
    let mut step = start(&opts).unwrap();
    for _ in 0..40 {
        if step["done"] == Value::Bool(true) {
            return (c, dir);
        }
        let given = answers(dir.path(), &a);
        step = submit(dir.path(), Some(&given), &[]).unwrap();
    }
    panic!("{name}: the run did not end");
}

fn file(path: &Path) -> String {
    craft_store::js::parse(&std::fs::read_to_string(path).unwrap())
        .unwrap()
        .compact()
}

#[test]
fn a_case_run_on_the_protocol_ends_with_the_engines_plan_and_record() {
    for name in [
        "repeats collapsed",
        "a dead validator is NOT JUDGED",
        "a dead gather source",
    ] {
        let (c, dir) = run_case(name);
        let want = c.at("expected");
        assert_eq!(
            file(&record_path(dir.path())),
            want.at("record").compact(),
            "{name}: the record"
        );
        // The agents' answers reach the run through the protocol's JSON, which keeps no key
        // order: the plan agent's own keys come back sorted, its content the engine's.
        let plan: Value = serde_json::from_str(&file(&plan_path(dir.path()))).unwrap();
        let want_plan = Value::try_from(want.at("plan")).unwrap();
        assert_eq!(plan, want_plan, "{name}: the plan");
        assert_eq!(status(dir.path()).unwrap()["done"], Value::Bool(true));
        assert!(matches!(
            submit(dir.path(), None, &[]),
            Err(TriageError::Done(_))
        ));
    }
}

#[test]
fn a_run_directory_holding_a_triage_is_refused() {
    let c = case("repeats collapsed");
    let (repo, dir) = (git_repo(), tempfile::tempdir().unwrap());
    let opts = StartOptions {
        cwd: repo.path().into(),
        run_dir: dir.path().into(),
        args: args_of(&c),
    };
    start(&opts).unwrap();
    assert!(matches!(start(&opts), Err(TriageError::RunExists(_))));
}

#[test]
fn an_answer_for_no_pending_task_is_refused() {
    let c = case("repeats collapsed");
    let (repo, dir) = (git_repo(), tempfile::tempdir().unwrap());
    let opts = StartOptions {
        cwd: repo.path().into(),
        run_dir: dir.path().into(),
        args: args_of(&c),
    };
    start(&opts).unwrap();
    let mut given = Map::new();
    given.insert("plan".into(), Value::Null);
    assert!(
        matches!(submit(dir.path(), Some(&given), &[]), Err(TriageError::UnknownTask(id)) if id == "plan")
    );
}
