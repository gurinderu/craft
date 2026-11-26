//! A run stopped on the host's limit and gone on, a limit that comes with every answer in, a task
//! abandoned at its deadline, and an answer missing on a resume.

use craft_step::TaskState;
use serde_json::{Value, json};

use super::{Unused, answers, case, git_repo, opts_of, seen_of};
use crate::parity::answers::CaseAnswers;
use crate::state;
use crate::step::{Said, start, status, submit};

const CASE: &str = "a dead gather source";

/// A started run of `CASE`: its directories, and its first step's pending task ids.
fn started() -> (tempfile::TempDir, tempfile::TempDir, Vec<String>) {
    let c = case(CASE);
    let (repo, dir) = (git_repo(), tempfile::tempdir().unwrap());
    let first = start(&opts_of(&c, repo.path(), dir.path()), &Unused).unwrap();
    let ids: Vec<String> = first["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].as_str().unwrap().to_owned())
        .collect();
    assert!(ids.len() >= 2, "{first}");
    (repo, dir, ids)
}

fn task_state(dir: &std::path::Path, id: &str) -> (TaskState, u32, bool) {
    let s = state::load(dir).unwrap();
    let t = s.tasks.iter().find(|t| t.id == id).unwrap();
    (t.state, t.retries, t.abandoned)
}

fn limited(text: &str) -> Said<'_> {
    Said {
        limit: Some(text),
        ..Said::default()
    }
}

fn ids_of(step: &Value) -> Vec<String> {
    let tasks = step["tasks"].as_array().cloned().unwrap_or_default();
    tasks
        .iter()
        .map(|t| t["id"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn the_hosts_limit_stops_the_run_keeping_what_came_in_its_held_tasks_whole() {
    let (_repo, dir, ids) = started();
    let c = case(CASE);
    let a = CaseAnswers::new(&c, None);
    let mut given = answers(dir.path(), &a);
    let kept = given.keys().next().cloned().unwrap();
    given.retain(|k, _| *k == kept);
    // A plain submit with no answer written counts a retry on every task.
    submit(dir.path(), None, &Said::default(), &Unused).unwrap();
    let held: Vec<&String> = ids.iter().filter(|id| **id != kept).collect();
    assert_eq!(task_state(dir.path(), held[0]).1, 1);
    let limit = limited("Claude Max\n  rate limit");
    let step = submit(dir.path(), Some(&given), &limit, &Unused).unwrap();
    assert_eq!(step["done"], true, "{step}");
    let cause = json!({"cause": "limit", "text": "Claude Max rate limit"});
    assert_eq!(step["stopped"], cause);
    let resume = format!(
        "craft triage submit --run '{}' --resume",
        dir.path().display()
    );
    assert_eq!(step["resume"], resume.as_str());
    let line = format!(
        "stopped: usage limit reached (Claude Max rate limit). Resume once the limit resets: `{resume}`"
    );
    assert_eq!(step["line"], line.as_str());
    assert_eq!(task_state(dir.path(), &kept).0, TaskState::Answered);
    for id in &held {
        let got = task_state(dir.path(), id);
        assert_eq!(got, (TaskState::Pending, 0, false), "{id}: held whole");
    }
    assert_eq!(status(dir.path()).unwrap()["stopped"], cause);
    let again = submit(dir.path(), None, &limit, &Unused).unwrap();
    assert_eq!(again, step, "still stopped");
    goes_on_uncounted(dir.path(), &held);
}

/// A plain submit of the stopped run in `dir` goes on: its `held` tasks handed out again, none
/// counted as a missing answer.
fn goes_on_uncounted(dir: &std::path::Path, held: &[&String]) {
    let go = submit(dir, None, &Said::default(), &Unused).unwrap();
    assert_eq!(go["done"], false, "{go}");
    assert!(go.get("stopped").is_none(), "{go}");
    let out = ids_of(&go);
    for id in held {
        assert!(out.contains(id), "{id} handed out again: {out:?}");
        assert_eq!(task_state(dir, id).1, 0, "{id}: not counted");
    }
    assert!(state::load(dir).unwrap().stopped.is_none());
}

#[test]
fn a_limit_with_every_answer_in_moves_on_and_the_last_one_finishes_the_run() {
    let name = "carry-forward of a prior ledger";
    let c = case(name);
    let (repo, dir) = (git_repo(), tempfile::tempdir().unwrap());
    let a = CaseAnswers::new(&c, None);
    let mut step = start(&opts_of(&c, repo.path(), dir.path()), &Unused).unwrap();
    let mut s = state::load(dir.path()).unwrap();
    s.seen = seen_of(&c);
    state::save(dir.path(), &s).unwrap();
    let (mut stops, mut last_limited) = (0, false);
    for _ in 0..40 {
        if step.get("plan").is_some() {
            break;
        }
        let given = answers(dir.path(), &a);
        // The limit comes with a step whose answers are all in; a dead agent's is missing.
        let before = state::load(dir.path()).unwrap();
        let all_in = given.len() == before.tasks.iter().filter(|t| t.pending()).count();
        let said = if all_in {
            limited("limit")
        } else {
            Said::default()
        };
        step = submit(dir.path(), Some(&given), &said, &Unused).unwrap();
        last_limited = all_in;
        if step.get("stopped").is_some() {
            stops += 1;
            let after = state::load(dir.path()).unwrap().phase;
            assert_ne!(
                after, before.phase,
                "a limit with every answer in moves on before it stops"
            );
            step = submit(dir.path(), None, &Said::default(), &Unused).unwrap();
            last_limited = false;
        }
    }
    assert!(
        last_limited,
        "the plan came from a submit that carried the limit"
    );
    assert!(stops > 0, "a phase that still needs agents stops");
    assert!(step.get("stopped").is_none(), "{step}");
    assert_eq!(step["done"], true, "{step}");
    let (_, _, plain) = super::run_case(name, &[]);
    assert_eq!(step["plan"], plain["plan"], "the plan as without the limit");
}

#[test]
fn a_limit_leaves_a_task_failed_in_a_finished_phase_failed() {
    let (_repo, dir, _) = started();
    let c = case(CASE);
    let a = CaseAnswers::new(&c, None);
    for _ in 0..10 {
        if state::load(dir.path()).unwrap().phase != crate::run::Phase::Gather {
            break;
        }
        let given = answers(dir.path(), &a);
        submit(dir.path(), Some(&given), &Said::default(), &Unused).unwrap();
    }
    let s = state::load(dir.path()).unwrap();
    assert_ne!(s.phase, crate::run::Phase::Gather);
    let dead = s
        .tasks
        .iter()
        .find(|t| t.state == TaskState::Failed)
        .unwrap()
        .id
        .clone();
    let none = serde_json::Map::new();
    let step = submit(dir.path(), Some(&none), &limited("limit"), &Unused).unwrap();
    assert!(step.get("stopped").is_some(), "{step}");
    assert_eq!(
        task_state(dir.path(), &dead).0,
        TaskState::Failed,
        "the gather source stays dead"
    );
}

#[test]
fn a_task_abandoned_as_a_stopped_run_goes_on_is_not_handed_out_again() {
    let (_repo, dir, ids) = started();
    let none = serde_json::Map::new();
    submit(dir.path(), Some(&none), &limited("limit"), &Unused).unwrap();
    let gone = [ids[0].clone()];
    let said = Said {
        abandoned: &gone,
        ..Said::default()
    };
    let go = submit(dir.path(), None, &said, &Unused).unwrap();
    assert_eq!(
        task_state(dir.path(), &ids[0]),
        (TaskState::Failed, 0, true)
    );
    assert!(!ids_of(&go).contains(&ids[0]), "{go}");
    assert!(ids_of(&go).contains(&ids[1]), "{go}");
}

#[test]
fn a_task_abandoned_at_its_deadline_fails_and_is_not_handed_out_again() {
    let (_repo, dir, ids) = started();
    let gone = [ids[0].clone()];
    let said = Said {
        abandoned: &gone,
        ..Said::default()
    };
    let step = submit(dir.path(), None, &said, &Unused).unwrap();
    assert_eq!(
        task_state(dir.path(), &ids[0]),
        (TaskState::Failed, 0, true)
    );
    assert!(!ids_of(&step).contains(&ids[0]), "{step}");
    assert!(
        ids_of(&step).contains(&ids[1]),
        "the others are handed out: {step}"
    );
}

#[test]
fn a_resume_hands_a_missing_answer_out_again_uncounted() {
    let (_repo, dir, ids) = started();
    let resumed = Said {
        resume: true,
        ..Said::default()
    };
    submit(dir.path(), None, &resumed, &Unused).unwrap();
    assert_eq!(
        task_state(dir.path(), &ids[0]),
        (TaskState::Pending, 0, false)
    );
    submit(dir.path(), None, &Said::default(), &Unused).unwrap();
    assert_eq!(
        task_state(dir.path(), &ids[0]).1,
        1,
        "a plain submit counts it"
    );
}
