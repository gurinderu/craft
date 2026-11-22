//! Taking answers over a kind that adds nothing: a refused answer file stays where its agent wrote
//! it until the kind applies the set-aside after saving its state.

use serde_json::json;
use std::path::Path;
use std::time::SystemTime;

use super::{Hold, take_pending};
use crate::handoff::{Aside, answers_dir};
use crate::test_kind::{Plain, task};
use crate::{Task, TaskState};

#[test]
fn a_refused_answer_is_moved_aside_only_when_applied() {
    let d = tempfile::tempdir().unwrap();
    let answers = answers_dir(d.path());
    std::fs::create_dir_all(&answers).unwrap();
    std::fs::write(answers.join("t.json"), "{}").unwrap();
    let mut tasks = [task()];
    let mut aside = Aside::default();
    let live = take_pending(d.path(), &mut tasks, None, Hold::Nothing, &mut aside).unwrap();
    assert!(live);
    assert_eq!((tasks[0].state, tasks[0].retries), (TaskState::Pending, 1));
    // Cut off here, before the state is saved, the refused file is still where it was written.
    assert!(answers.join("t.json").is_file());
    assert!(aside.apply().is_empty());
    assert!(!answers.join("t.json").exists());
    assert!(answers.join("t.rejected-0.json").is_file());
}

#[test]
fn an_accepted_answer_stays_in_place() {
    let d = tempfile::tempdir().unwrap();
    let answers = answers_dir(d.path());
    std::fs::create_dir_all(&answers).unwrap();
    std::fs::write(answers.join("t.json"), r#"{"ok": true}"#).unwrap();
    let mut tasks = [task()];
    let mut aside = Aside::default();
    take_pending(d.path(), &mut tasks, None, Hold::Nothing, &mut aside).unwrap();
    assert!(aside.apply().is_empty());
    assert_eq!(tasks[0].state, TaskState::Answered);
    assert!(answers.join("t.json").is_file());
}

#[test]
fn a_refused_file_read_again_before_it_is_set_aside_is_counted_once() {
    let d = tempfile::tempdir().unwrap();
    let answers = answers_dir(d.path());
    std::fs::create_dir_all(&answers).unwrap();
    std::fs::write(answers.join("t.json"), "{}").unwrap();
    let mut tasks = [task()];
    let cut_off = {
        let mut aside = Aside::default();
        take_pending(d.path(), &mut tasks, None, Hold::Nothing, &mut aside).unwrap();
        aside
    };
    // The state saved, the set-aside never applied: the same file is read again.
    drop(cut_off);
    let mut aside = Aside::default();
    let live = take_pending(d.path(), &mut tasks, None, Hold::Nothing, &mut aside).unwrap();
    assert!(!live, "no agent answered this time");
    assert_eq!((tasks[0].state, tasks[0].retries), (TaskState::Pending, 1));
    assert!(aside.apply().is_empty());
    assert!(!answers.join("t.json").exists());
    // The agent's next answer, the same bytes written anew, is a refusal of its own.
    let again = answers.join("t.json");
    std::fs::write(&again, "{}").unwrap();
    let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
    std::fs::File::options()
        .write(true)
        .open(&again)
        .unwrap()
        .set_modified(later)
        .unwrap();
    let mut aside = Aside::default();
    take_pending(d.path(), &mut tasks, None, Hold::Nothing, &mut aside).unwrap();
    assert_eq!((tasks[0].state, tasks[0].retries), (TaskState::Pending, 2));
    assert!(aside.apply().is_empty());
}

/// Takes the pending answers of `tasks` from their files, never moving a refused one aside.
fn take_unmoved(dir: &Path, tasks: &mut [Task<Plain>]) -> bool {
    let mut aside = Aside::default();
    let live = take_pending(dir, tasks, None, Hold::Nothing, &mut aside).unwrap();
    drop(aside);
    live
}

fn answers_with(text: &str) -> (tempfile::TempDir, std::path::PathBuf) {
    let d = tempfile::tempdir().unwrap();
    let answers = answers_dir(d.path());
    std::fs::create_dir_all(&answers).unwrap();
    std::fs::write(answers.join("t.json"), text).unwrap();
    (d, answers)
}

fn set_written(path: &Path, at: SystemTime) {
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(at)
        .unwrap();
}

#[test]
fn a_refused_file_that_never_moves_fails_its_task_in_the_end() {
    let (d, _answers) = answers_with("{}");
    let mut tasks = [task()];
    let mut seen = Vec::new();
    for _ in 0..10 {
        if !tasks[0].pending() {
            break;
        }
        take_unmoved(d.path(), &mut tasks);
        seen.push(tasks[0].retries);
    }
    assert_eq!(tasks[0].state, TaskState::Failed, "{seen:?}");
    assert_eq!(
        seen,
        [1, 1, 2, 2],
        "counted, read again free, then a missing answer each time"
    );
    assert!(
        tasks[0]
            .error
            .as_deref()
            .unwrap()
            .contains("no new answer was written")
    );
}

#[test]
fn other_bytes_with_the_same_write_time_are_a_new_answer() {
    let (d, answers) = answers_with("{}");
    let file = answers.join("t.json");
    let at = std::fs::metadata(&file).unwrap().modified().unwrap();
    let mut tasks = [task()];
    take_unmoved(d.path(), &mut tasks);
    std::fs::write(&file, "[]").unwrap();
    set_written(&file, at);
    assert!(take_unmoved(d.path(), &mut tasks));
    assert_eq!(tasks[0].retries, 2);
}

#[test]
fn an_accepted_or_blocked_answer_forgets_the_counted_file() {
    for (answer, state) in [
        (r#"{"ok": true}"#, TaskState::Answered),
        (r#"{"blocked": "no tools"}"#, TaskState::Failed),
    ] {
        let (d, answers) = answers_with("{}");
        let mut tasks = [task()];
        take_unmoved(d.path(), &mut tasks);
        assert!(tasks[0].counted.is_some());
        let file = answers.join("t.json");
        std::fs::write(&file, answer).unwrap();
        set_written(&file, SystemTime::now() + std::time::Duration::from_secs(5));
        take_unmoved(d.path(), &mut tasks);
        assert_eq!((tasks[0].state, tasks[0].counted.clone()), (state, None));
    }
}

#[test]
fn a_refusal_given_by_the_host_keeps_the_counted_file() {
    let (d, _answers) = answers_with("{}");
    let mut tasks = [task()];
    take_unmoved(d.path(), &mut tasks);
    let counted = tasks[0].counted.clone();
    let given: serde_json::Map<String, serde_json::Value> =
        [("t".to_owned(), json!({}))].into_iter().collect();
    let mut aside = Aside::default();
    take_pending(
        d.path(),
        &mut tasks,
        Some(&given),
        Hold::Nothing,
        &mut aside,
    )
    .unwrap();
    assert!(aside.apply().is_empty());
    assert_eq!((tasks[0].retries, tasks[0].counted.clone()), (2, counted));
}

#[test]
fn a_resume_holds_a_counted_file_found_there_again_and_the_next_round_counts_it() {
    let (d, _answers) = answers_with("{}");
    let mut tasks = [task()];
    take_unmoved(d.path(), &mut tasks);
    let resume = |tasks: &mut [Task<Plain>]| {
        let mut aside = Aside::default();
        let live = take_pending(d.path(), tasks, None, Hold::Missing, &mut aside).unwrap();
        drop(aside);
        live
    };
    let mut seen = Vec::new();
    for _ in 0..3 {
        assert!(!resume(&mut tasks));
        seen.push((tasks[0].retries, tasks[0].counted.clone().unwrap().again));
    }
    assert_eq!(
        seen,
        [(1, true), (1, true), (1, true)],
        "no resume, its round unrun, spends a retry"
    );
    assert_eq!(tasks[0].state, TaskState::Pending);
    // A round that ran and left the same file there counts it as a missing answer.
    take_unmoved(d.path(), &mut tasks);
    assert_eq!(tasks[0].retries, 2);
    assert!(
        tasks[0]
            .error
            .as_deref()
            .unwrap()
            .contains("no new answer was written")
    );
}

#[test]
fn a_resume_keeps_the_counted_file_when_its_answer_is_missing() {
    let (d, answers) = answers_with("{}");
    let mut tasks = [task()];
    take_unmoved(d.path(), &mut tasks);
    let counted = tasks[0].counted.clone();
    assert!(counted.is_some());
    // A resume reads the file gone (moved aside meanwhile): handed out again as first written.
    std::fs::remove_file(answers.join("t.json")).unwrap();
    let mut aside = Aside::default();
    let live = take_pending(d.path(), &mut tasks, None, Hold::Missing, &mut aside).unwrap();
    drop(aside);
    assert!(!live);
    assert_eq!((tasks[0].retries, tasks[0].counted.clone()), (0, counted));
}

#[test]
fn the_hosts_limit_holds_a_counted_file_found_there_again_uncounted() {
    let (d, _answers) = answers_with("{}");
    let mut tasks = [task()];
    take_unmoved(d.path(), &mut tasks);
    for _ in 0..3 {
        let mut aside = Aside::default();
        let live = take_pending(d.path(), &mut tasks, None, Hold::Every, &mut aside).unwrap();
        drop(aside);
        assert!(!live);
    }
    let held = &tasks[0];
    assert_eq!(
        (
            held.state,
            held.retries,
            held.counted.as_ref().map(|c| c.again)
        ),
        (TaskState::Pending, 1, Some(true))
    );
}
