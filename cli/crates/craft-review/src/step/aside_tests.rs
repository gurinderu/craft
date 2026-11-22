//! A refused answer file the set-aside cannot move: a note on the run saying what its next read
//! does, saved with it; a failed second save fails the submit.

use std::cell::Cell;
use std::path::Path;

use craft_step::{Aside, Counted, Model};
use serde_json::json;

use super::{Said, save_and_next_with, set_aside};
use crate::state::{self, Phase, RunState, STATE_VERSION, StateError, Task, TaskKind};

fn run_with(task: &Task) -> RunState {
    let mut run: RunState = serde_json::from_value(json!({
        "version": STATE_VERSION,
        "context": {"repo": "/r", "base": "origin/main", "spec": "", "craftRoot": null, "craftVersion": null},
        "diff": {"base": "origin/main", "mergeBase": "abc", "head": "def", "dirty": false,
                 "files": ["src/lib.rs"], "stat": "", "log": ""},
        "tracks": [], "uncovered": [], "light": false, "phase": "verify", "tasks": [],
        "rounds": {"round": 1, "pool": [], "yields": [], "expected": [], "returned": [], "failures": {}},
        "findings": [], "settled": [], "notes": [], "notRun": []
    }))
    .unwrap();
    run.tasks.push(task.clone());
    run
}

fn task() -> Task {
    Task::new(
        "critic-rust".into(),
        "critic:rust".into(),
        "p".into(),
        Model::Haiku,
        json!({}),
        TaskKind::Critic {
            profile: "rust".into(),
        },
    )
}

/// A run directory whose task's answer file is a directory with something in it: claimed, its
/// set-aside name cannot be renamed over.
fn unmovable(task: &Task) -> (tempfile::TempDir, Aside) {
    let d = tempfile::tempdir().unwrap();
    let file = d.path().join("answers").join("critic-rust.json");
    std::fs::create_dir_all(&file).unwrap();
    std::fs::write(file.join("x"), "").unwrap();
    let mut aside = Aside::default();
    aside.mark(d.path(), task).unwrap();
    (d, aside)
}

fn has(list: &[String], text: &str) -> bool {
    list.iter().any(|n| n.contains(text))
}

fn counted(again: bool) -> Counted {
    Counted {
        print: "p".into(),
        at: 0,
        again,
    }
}

#[test]
fn a_file_left_in_place_is_noted_and_the_note_saved() {
    let mut task = task();
    task.counted = Some(counted(false));
    let (d, aside) = unmovable(&task);
    let mut run = run_with(&task);
    set_aside(d.path(), &mut run, aside, &state::save).unwrap();
    let saved = state::load(d.path()).unwrap();
    assert!(
        has(
            &saved.notes,
            "set aside uncounted, and found there once more"
        ),
        "{:?}",
        saved.notes
    );
}

#[test]
fn the_note_says_what_the_next_read_does() {
    for (held, says) in [
        (None, "taken as a new answer"),
        (
            Some(counted(true)),
            "found there again, it counts as a missing answer",
        ),
    ] {
        let mut task = task();
        task.counted = held;
        let (d, aside) = unmovable(&task);
        let mut run = run_with(&task);
        set_aside(d.path(), &mut run, aside, &state::save).unwrap();
        assert!(has(&run.notes, says), "{:?}", run.notes);
    }
}

#[test]
fn a_failed_second_save_fails_the_submit() {
    let mut task = task();
    task.counted = Some(counted(false));
    let (d, aside) = unmovable(&task);
    let mut run = run_with(&task);
    let calls = Cell::new(0);
    let second_fails = |dir: &Path, run: &RunState| {
        calls.set(calls.get() + 1);
        if calls.get() == 1 {
            return state::save(dir, run);
        }
        Err(StateError::Unwritable {
            path: dir.join("state.json"),
            source: std::io::Error::other("disk full"),
        })
    };
    let got = save_and_next_with(d.path(), &mut run, &Said::default(), aside, &second_fails);
    let e = got.expect_err("the second save fails the submit");
    assert!(crate::sources::chain(&e).contains("disk full"), "{e}");
    assert_eq!(calls.get(), 2);
    // The first save stands: the refusal it counted is there to be read again uncounted.
    let saved = state::load(d.path()).unwrap();
    assert_eq!(saved.tasks[0].counted, task.counted);
    assert!(saved.notes.is_empty());
}

#[test]
fn a_finished_runs_file_is_said_to_stay() {
    let task = task();
    let (d, aside) = unmovable(&task);
    let mut run = run_with(&task);
    run.phase = Phase::Done;
    set_aside(d.path(), &mut run, aside, &state::save).unwrap();
    assert!(has(&run.notes, "its task is settled"), "{:?}", run.notes);
}

#[test]
fn a_stop_keeps_the_counted_file_a_resume_reads_again() {
    let mut task = task();
    task.retries = 2;
    task.counted = Some(counted(true));
    let mut run = run_with(&task);
    crate::stop::hold(
        &mut run,
        crate::stop::Stop {
            cause: crate::stop::Cause::Deaths,
            text: "every agent died".into(),
        },
    );
    let held = &run.tasks[0];
    assert_eq!((held.retries, held.counted.clone()), (0, task.counted));
}
