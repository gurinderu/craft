//! A run stopped on the host's limit and resumed, a task abandoned at its deadline, and an answer
//! missing on a resume.

use craft_step::TaskState;
use serde_json::json;

use super::{Unused, answers, case, git_repo, opts_of};
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

#[test]
fn the_hosts_limit_stops_the_run_keeping_what_came_in_and_a_resume_hands_out_the_rest() {
    let (_repo, dir, ids) = started();
    let c = case(CASE);
    let a = CaseAnswers::new(&c, None);
    let mut given = answers(dir.path(), &a);
    let kept = given.keys().next().cloned().unwrap();
    given.retain(|k, _| *k == kept);
    let limit = Said {
        limit: Some("Claude Max\n  rate limit"),
        ..Said::default()
    };
    let step = submit(dir.path(), Some(&given), &limit, &Unused).unwrap();
    assert_eq!(step["done"], true, "{step}");
    assert_eq!(
        step["stopped"],
        json!({"cause": "limit", "text": "Claude Max rate limit"})
    );
    let resume = step["resume"].as_str().unwrap();
    assert!(resume.starts_with("craft triage submit --run '") && resume.ends_with("' --resume"));
    let line = step["line"].as_str().unwrap();
    assert!(line.starts_with("stopped: usage limit reached (Claude Max rate limit). Resume once the limit resets: `craft triage"), "{line}");
    assert_eq!(task_state(dir.path(), &kept).0, TaskState::Answered);
    let held: Vec<&String> = ids.iter().filter(|id| **id != kept).collect();
    for id in &held {
        assert_eq!(
            task_state(dir.path(), id),
            (TaskState::Pending, 0, false),
            "{id}"
        );
    }
    assert_eq!(status(dir.path()).unwrap()["stopped"], step["stopped"]);
    assert_eq!(
        submit(dir.path(), None, &limit, &Unused).unwrap(),
        step,
        "still stopped"
    );
    let resumed = Said {
        resume: true,
        ..Said::default()
    };
    let go = submit(dir.path(), None, &resumed, &Unused).unwrap();
    assert_eq!(go["done"], false, "{go}");
    assert!(go.get("stopped").is_none(), "{go}");
    let out: Vec<&str> = go["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].as_str().unwrap())
        .collect();
    for id in &held {
        assert!(out.contains(&id.as_str()), "{id} handed out again: {out:?}");
    }
    assert!(state::load(dir.path()).unwrap().stopped.is_none());
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
    let out = step["tasks"].as_array().cloned().unwrap_or_default();
    assert!(!out.iter().any(|t| t["id"] == ids[0].as_str()), "{step}");
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
