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

/// The ids of every record the case recalls or passes.
fn record_ids(c: &Js) -> Vec<String> {
    let recall = c.at("answers").at("memoryRecall");
    let lists = ["decisions", "questions", "rules"].map(|k| recall.at(k));
    let passed = c.at("args").at("priorDecisions");
    let mut ids = Vec::new();
    for list in lists.iter().chain([&passed]) {
        for r in list.as_arr().unwrap_or_default() {
            ids.extend(r.at("id").as_str().map(str::to_owned));
        }
    }
    ids
}

/// The case's scope check as the run's state keeps what git saw: every record checked, those its
/// answer names unchanged or missing so, as a submit after the one that observed them reads it.
fn seen_of(c: &Js) -> state::Seen {
    let scope = c.at("answers").at("scope");
    let named = |k: &str| -> std::collections::BTreeSet<String> {
        let read = scope.at("unchanged").as_arr().is_some();
        let list = scope.at(k).as_arr().filter(|_| read).unwrap_or_default();
        list.iter()
            .filter_map(|x| x.as_str().map(str::to_owned))
            .collect()
    };
    state::Seen {
        checked: record_ids(c).into_iter().collect(),
        unchanged: named("unchanged"),
        missing: named("missing"),
    }
}

/// The case's arguments, a repository it names replaced by `repo`: the run must read one.
fn opts_of(c: &Js, repo: &Path, dir: &Path) -> StartOptions {
    let mut args = args_of(c);
    if !args.repo.is_empty() {
        args.repo = repo.display().to_string();
    }
    StartOptions {
        cwd: repo.into(),
        run_dir: dir.into(),
        args,
    }
}

/// Runs `name` to its end, the answers handed in by task id, `degraded` said at every submit.
fn run_case(name: &str, degraded: &[String]) -> (Js, tempfile::TempDir, Value) {
    let c = case(name);
    let (repo, dir) = (git_repo(), tempfile::tempdir().unwrap());
    let a = CaseAnswers::new(&c, None);
    let mut step = start(&opts_of(&c, repo.path(), dir.path())).unwrap();
    let mut s = state::load(dir.path()).unwrap();
    s.seen = seen_of(&c);
    state::save(dir.path(), &s).unwrap();
    for _ in 0..40 {
        if step["done"] == Value::Bool(true) {
            return (c, dir, step);
        }
        let given = answers(dir.path(), &a);
        step = submit(dir.path(), Some(&given), degraded).unwrap();
    }
    panic!("{name}: the run did not end");
}

fn file(path: &Path) -> String {
    craft_store::js::parse(&std::fs::read_to_string(path).unwrap())
        .unwrap()
        .compact()
}

#[test]
fn every_case_run_on_the_protocol_ends_with_the_engines_plan_and_record() {
    for c in cases() {
        let name = c.at("name").as_str().unwrap().to_owned();
        let (c, dir, _) = run_case(&name, &[]);
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
        let st = status(dir.path()).unwrap();
        assert_eq!(st["done"], Value::Bool(true));
        let named = |k: &str| st[k].as_str().map(std::path::PathBuf::from);
        assert_eq!(
            named("planFile"),
            Some(plan_path(dir.path())),
            "{name}: status names the plan"
        );
        assert_eq!(named("recordFile"), Some(record_path(dir.path())), "{name}");
        assert!(matches!(
            submit(dir.path(), None, &[]),
            Err(TriageError::Done(_))
        ));
    }
}

#[test]
fn the_hosts_degraded_notes_lead_the_plan_and_reach_the_step_and_the_status() {
    let note = vec!["a validator ran without the agent it named".to_owned()];
    let (_, dir, step) = run_case("repeats collapsed", &note);
    let plan: Value = serde_json::from_str(&file(&plan_path(dir.path()))).unwrap();
    let body = plan["plan_markdown"].as_str().unwrap();
    assert!(body.starts_with("> **DEGRADED**"), "{body}");
    assert!(body.contains(&note[0]), "{body}");
    assert!(
        body.ends_with("\nBODY"),
        "the agent's plan stays under the banner: {body}"
    );
    let summary = plan["summary"].as_str().unwrap();
    assert_eq!(summary, format!("DEGRADED: {}\n\nSUM", note[0]));
    assert_eq!(plan["degraded"], serde_json::json!(note));
    assert_eq!(
        step["degraded"],
        serde_json::json!(note),
        "the finished step"
    );
    assert_eq!(
        step["plan"], plan,
        "the finished step carries the plan its file holds"
    );
    assert_eq!(
        status(dir.path()).unwrap()["degraded"],
        serde_json::json!(note)
    );
    let (_, clean, step) = run_case("repeats collapsed", &[]);
    let plan: Value = serde_json::from_str(&file(&plan_path(clean.path()))).unwrap();
    assert!(plan.get("degraded").is_none() && step.get("degraded").is_none());
}

#[test]
fn a_triage_with_no_source_or_a_relative_repository_is_refused_before_any_agent() {
    let c = case("repeats collapsed");
    let (repo, dir) = (git_repo(), tempfile::tempdir().unwrap());
    let mut opts = opts_of(&c, repo.path(), dir.path());
    opts.args.report.clear();
    opts.args.pr.clear();
    assert!(
        matches!(start(&opts), Err(TriageError::Refused(why)) if why.contains("needs a source"))
    );
    let mut opts = opts_of(&c, repo.path(), dir.path());
    opts.args.repo = "some/where".into();
    assert!(
        matches!(start(&opts), Err(TriageError::Refused(why)) if why.contains("absolute path"))
    );
    assert!(
        !state::state_path(dir.path()).exists(),
        "nothing was opened"
    );
}

#[test]
fn a_run_directory_holding_a_triage_is_refused() {
    let c = case("repeats collapsed");
    let (repo, dir) = (git_repo(), tempfile::tempdir().unwrap());
    let opts = opts_of(&c, repo.path(), dir.path());
    start(&opts).unwrap();
    assert!(matches!(start(&opts), Err(TriageError::RunExists(_))));
}

#[test]
fn an_answer_for_no_pending_task_is_refused() {
    let c = case("repeats collapsed");
    let (repo, dir) = (git_repo(), tempfile::tempdir().unwrap());
    let opts = opts_of(&c, repo.path(), dir.path());
    start(&opts).unwrap();
    let mut given = Map::new();
    given.insert("plan".into(), Value::Null);
    assert!(
        matches!(submit(dir.path(), Some(&given), &[]), Err(TriageError::UnknownTask(id)) if id == "plan")
    );
}

#[test]
fn a_refused_answer_file_is_moved_aside_and_its_task_asked_again() {
    let c = case("repeats collapsed");
    let (repo, dir) = (git_repo(), tempfile::tempdir().unwrap());
    let step = start(&opts_of(&c, repo.path(), dir.path())).unwrap();
    let file = std::path::PathBuf::from(step["tasks"][0]["answerFile"].as_str().unwrap());
    std::fs::write(&file, "{}").unwrap();
    let again = submit(dir.path(), None, &[]).unwrap();
    assert!(!file.exists(), "the refused file is moved aside");
    let aside = file.with_file_name("gather-report.rejected-0.json");
    assert!(aside.exists(), "{aside:?}");
    assert_eq!(again["tasks"][0]["id"], "gather-report", "{again}");
    assert!(again.get("notes").is_none(), "{again}");
}

#[cfg(unix)]
#[test]
fn a_refused_answer_file_that_cannot_be_moved_is_noted_with_what_its_next_read_does() {
    use std::os::unix::fs::PermissionsExt;
    let c = case("repeats collapsed");
    let (repo, dir) = (git_repo(), tempfile::tempdir().unwrap());
    let step = start(&opts_of(&c, repo.path(), dir.path())).unwrap();
    let file = std::path::PathBuf::from(step["tasks"][0]["answerFile"].as_str().unwrap());
    std::fs::write(&file, "{}").unwrap();
    let answers = file.parent().unwrap().to_owned();
    std::fs::set_permissions(&answers, std::fs::Permissions::from_mode(0o555)).unwrap();
    let again = submit(dir.path(), None, &[]);
    std::fs::set_permissions(&answers, std::fs::Permissions::from_mode(0o755)).unwrap();
    let again = again.unwrap();
    if !file.exists() {
        // A user the directory's mode does not bind (root) moved it all the same.
        return;
    }
    let notes = again["notes"]
        .as_array()
        .expect("the step says what it could not move");
    let note = notes[0].as_str().unwrap();
    assert!(
        note.contains("gather-report.json aside: ") && note.contains(": left in place; "),
        "{note}"
    );
    // Its refusal was counted by its print, so read again it is not a new answer.
    let then = "read again, it is set aside uncounted, and found there once more after a round that ran it counts as a missing answer";
    assert!(note.ends_with(then), "{note}");
    // The error with its cause: what was moved, and why the system refused it.
    assert!(
        note.contains("gather-report.json aside: ") && note.contains("(os error 13)"),
        "{note}"
    );
    assert_eq!(
        state::load(dir.path()).unwrap().notes,
        [note],
        "saved with the state"
    );
}
