//! A refused answer file the set-aside cannot move: a note on the run saying what its next read
//! does, saved with it; a failed second save fails the submit only while the run goes on.

use std::cell::Cell;
use std::path::Path;

use craft_step::take::take_pending;
use craft_step::{Aside, Counted, Hold, Model, TaskState};
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
/// set-aside name cannot be renamed over. Marked as the file `task.counted` names, when it names one.
fn unmovable(task: &Task) -> (tempfile::TempDir, Aside) {
    let d = tempfile::tempdir().unwrap();
    let file = d.path().join("answers").join("critic-rust.json");
    std::fs::create_dir_all(&file).unwrap();
    std::fs::write(file.join("x"), "").unwrap();
    let mut aside = Aside::default();
    aside
        .mark_at(d.path(), task, task.retries, task.counted.is_some())
        .unwrap();
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

/// A state writer whose first save lands and every later one fails, counting them in `calls`.
fn second_fails(calls: &Cell<u32>) -> impl Fn(&Path, &RunState) -> Result<(), StateError> + '_ {
    move |dir, run| {
        calls.set(calls.get() + 1);
        if calls.get() == 1 {
            return state::save(dir, run);
        }
        Err(StateError::Unwritable {
            path: dir.join("state.json"),
            source: std::io::Error::other("disk full"),
        })
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
            "found there again after a round that ran, it counts as a missing answer",
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
fn a_file_read_with_no_print_is_noted_as_a_new_answer_whatever_was_counted_before() {
    let mut task = task();
    task.counted = Some(counted(false));
    let d = tempfile::tempdir().unwrap();
    let file = d.path().join("answers").join("critic-rust.json");
    std::fs::create_dir_all(&file).unwrap();
    std::fs::write(file.join("x"), "").unwrap();
    let mut aside = Aside::default();
    aside.mark_at(d.path(), &task, 0, false).unwrap();
    let mut run = run_with(&task);
    set_aside(d.path(), &mut run, aside, &state::save).unwrap();
    assert!(has(&run.notes, "taken as a new answer"), "{:?}", run.notes);
}

#[test]
fn a_failed_second_save_fails_the_submit_while_the_run_goes_on() {
    let mut task = task();
    task.counted = Some(counted(false));
    let (d, aside) = unmovable(&task);
    let mut run = run_with(&task);
    let calls = Cell::new(0);
    let got = save_and_next_with(
        d.path(),
        &mut run,
        &Said::default(),
        aside,
        &second_fails(&calls),
    );
    let e = got.expect_err("the second save fails the submit");
    assert!(crate::sources::chain(&e).contains("disk full"), "{e}");
    assert_eq!(calls.get(), 2);
    assert!(state::load(d.path()).unwrap().notes.is_empty());
}

#[test]
fn a_finishing_submit_whose_second_save_fails_still_returns_its_finished_step() {
    let task = task();
    let (d, aside) = unmovable(&task);
    let mut run = run_with(&task);
    run.phase = Phase::Done;
    run.verdict = Some("Approve".into());
    let calls = Cell::new(0);
    let step = save_and_next_with(
        d.path(),
        &mut run,
        &Said::default(),
        aside,
        &second_fails(&calls),
    )
    .expect("a done run's note is information alone");
    assert_eq!((step["done"].clone(), calls.get()), (json!(true), 2));
    assert_eq!(state::load(d.path()).unwrap().phase, Phase::Done);
}

#[test]
fn a_settled_tasks_file_is_said_to_stay_and_its_failed_save_let_go() {
    let mut task = task();
    task.state = TaskState::Failed;
    let (d, aside) = unmovable(&task);
    let mut run = run_with(&task);
    // Past its first call, so the note's save is the one that fails.
    set_aside(d.path(), &mut run, aside, &second_fails(&Cell::new(1))).unwrap();
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

/// `answers/` read-only while it lives; `None` where the test runs with rights that write there
/// anyway (root).
#[cfg(unix)]
struct Locked(std::path::PathBuf);

#[cfg(unix)]
impl Locked {
    fn new(answers: &Path) -> Option<Self> {
        use std::os::unix::fs::PermissionsExt;
        let locked = Self(answers.to_owned());
        std::fs::set_permissions(answers, std::fs::Permissions::from_mode(0o555)).unwrap();
        let probe = answers.join(".probe");
        if std::fs::write(&probe, "").is_ok() {
            std::fs::remove_file(&probe).unwrap();
            return None;
        }
        Some(locked)
    }
}

#[cfg(unix)]
impl Drop for Locked {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

#[cfg(unix)]
/// The run in `dir`, its pending answers taken with `hold`, then saved and handed on as a step
/// whose second save fails.
fn submit_failing(dir: &Path, hold: Hold) -> RunState {
    let mut run = state::load(dir).unwrap();
    let mut aside = Aside::default();
    take_pending(dir, &mut run.tasks, None, hold, &mut aside).unwrap();
    let calls = Cell::new(0);
    let got = save_and_next_with(
        dir,
        &mut run,
        &Said::default(),
        aside,
        &second_fails(&calls),
    );
    assert!(
        got.is_err() || calls.get() < 2,
        "a failing second save fails the submit"
    );
    state::load(dir).unwrap()
}

#[cfg(unix)]
#[test]
fn a_resume_after_a_failed_second_save_reads_the_file_as_counted_and_spends_no_retry() {
    let d = tempfile::tempdir().unwrap();
    let answers = d.path().join("answers");
    std::fs::create_dir_all(&answers).unwrap();
    std::fs::write(answers.join("critic-rust.json"), "not json").unwrap();
    state::save(d.path(), &run_with(&task())).unwrap();
    let Some(lock) = Locked::new(&answers) else {
        return; // root writes through the lock: nothing to test here
    };
    let at = |run: &RunState| {
        let t = &run.tasks[0];
        (t.retries, t.counted.as_ref().map(|c| c.again))
    };
    let counted = submit_failing(d.path(), Hold::Nothing);
    assert_eq!(at(&counted), (1, Some(false)), "the refusal counted once");
    let again = submit_failing(d.path(), Hold::Missing);
    assert_eq!(
        at(&again),
        (1, Some(true)),
        "read again, set aside uncounted"
    );
    let held = submit_failing(d.path(), Hold::Missing);
    assert_eq!(
        at(&held),
        (1, Some(true)),
        "a resume's unrun round spends nothing"
    );
    drop(lock);
    // A round that ran and found it there still: counted as a missing answer, then moved aside.
    let mut run = state::load(d.path()).unwrap();
    let mut aside = Aside::default();
    take_pending(d.path(), &mut run.tasks, None, Hold::Nothing, &mut aside).unwrap();
    save_and_next_with(d.path(), &mut run, &Said::default(), aside, &state::save).unwrap();
    assert_eq!(state::load(d.path()).unwrap().tasks[0].retries, 2);
    assert!(!answers.join("critic-rust.json").exists());
}
