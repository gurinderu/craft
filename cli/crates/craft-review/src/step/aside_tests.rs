//! A refused answer file the set-aside cannot move: a note on the run, and, when the run cannot be
//! saved with it, a warning the step carries and its degraded notes keep — never a failed submit.

use std::path::Path;

use craft_step::{Aside, Model};
use serde_json::{Value, json};

use super::{set_aside, warned};
use crate::state::{Phase, RunState, STATE_VERSION, StateError, Task, TaskKind};

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

fn unsaved(dir: &Path, _: &RunState) -> Result<(), StateError> {
    Err(StateError::Unwritable {
        path: dir.join("state.json"),
        source: std::io::Error::other("disk full"),
    })
}

fn has(list: &[String], text: &str) -> bool {
    list.iter().any(|n| n.contains(text))
}

#[test]
fn a_file_left_in_place_is_noted_and_the_note_saved() {
    let task = task();
    let (d, aside) = unmovable(&task);
    let mut run = run_with(&task);
    assert_eq!(
        set_aside(d.path(), &mut run, aside, crate::state::save),
        None
    );
    assert!(
        has(&run.notes, "counts as a missing answer"),
        "{:?}",
        run.notes
    );
    assert!(run.degraded.is_empty());
}

#[test]
fn a_failed_second_save_is_a_warning_the_step_and_the_run_carry() {
    let task = task();
    let (d, aside) = unmovable(&task);
    let mut run = run_with(&task);
    let warning = set_aside(d.path(), &mut run, aside, unsaved).expect("a warning");
    assert!(
        warning.contains("could not record it") && warning.contains("disk full"),
        "{warning}"
    );
    assert_eq!(run.degraded, std::slice::from_ref(&warning));
    let step = warned(json!({"done": false, "tasks": []}), Some(warning.clone()));
    assert_eq!(step["warnings"], json!([warning]));
    assert_eq!(
        warned(json!({"done": false}), None).get("warnings"),
        None::<&Value>
    );
}

#[test]
fn a_finished_runs_file_is_said_to_stay() {
    let task = task();
    let (d, aside) = unmovable(&task);
    let mut run = run_with(&task);
    run.phase = Phase::Done;
    assert_eq!(
        set_aside(d.path(), &mut run, aside, crate::state::save),
        None
    );
    assert!(has(&run.notes, "its task is settled"), "{:?}", run.notes);
}

#[test]
fn a_stop_keeps_the_counted_file_a_resume_reads_again() {
    let mut task = task();
    task.retries = 2;
    task.counted = Some(craft_step::Counted {
        print: "p".into(),
        at: 1,
        again: true,
    });
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
