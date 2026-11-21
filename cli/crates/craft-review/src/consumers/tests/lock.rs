//! One review at a time indexes a project, and an index is never killed (realm @nick/craft, node
//! #530): a second review waits for the lock within its time, then leaves the graph unasked; a
//! dead holder's lock is taken over; an index past the time left, or one a stop reaches, goes on
//! in the background and removes the lock when it ends.

use std::path::Path;
use std::time::{Duration, Instant};

use crate::cancel::Cancel;
use crate::consumers::cbm::{Cbm, CbmError};
use crate::gate::tests::exe;

/// A stand-in whose index takes `secs`, then marks that it finished.
fn slow(t: &Path, secs: u32) -> Cbm {
    let tool = t.join("cbm");
    let script = format!(
        "#!/bin/sh\nsleep {secs}; echo done >> {marker}; echo '{{\"status\":\"indexed\"}}'\n",
        marker = t.join("finished").display()
    );
    exe::write_executable(&tool, &script).unwrap();
    Cbm::new(&tool.display().to_string()).locked_in(&t.join("locks"))
}

fn lock(t: &Path) -> std::path::PathBuf {
    t.join("locks").join("proj.lock")
}

/// Waits up to 10 s for `done`.
fn eventually(done: impl Fn() -> bool) -> bool {
    let until = Instant::now() + Duration::from_secs(10);
    while Instant::now() < until {
        if done() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

#[test]
fn an_index_that_ends_in_time_removes_its_lock() {
    let t = tempfile::tempdir().unwrap();
    let cbm = slow(t.path(), 0);
    let far = Instant::now() + Duration::from_secs(30);
    cbm.reindex("/r", "proj", far).unwrap();
    assert!(!lock(t.path()).exists());
}

#[test]
fn a_lock_another_holds_past_the_time_left_leaves_the_graph_unasked() {
    let t = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(lock(t.path())).unwrap();
    std::fs::write(lock(t.path()).join("owner"), "another").unwrap();
    let cbm = slow(t.path(), 0);
    let start = Instant::now();
    let why = cbm
        .reindex("/r", "proj", start + Duration::from_millis(300))
        .unwrap_err();
    assert!(matches!(why, CbmError::Locked { .. }), "{why}");
    assert!(
        why.to_string().contains("another review is indexing proj"),
        "{why}"
    );
    assert!(start.elapsed() < Duration::from_secs(3));
    assert!(!t.path().join("finished").exists(), "it indexed");
    assert_eq!(
        std::fs::read_to_string(lock(t.path()).join("owner")).unwrap(),
        "another"
    );
}

#[test]
fn a_dead_holder_s_lock_is_taken_over() {
    let t = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(lock(t.path())).unwrap();
    let old = std::process::Command::new("touch")
        .args(["-d", "2000-01-01", &lock(t.path()).display().to_string()])
        .status()
        .unwrap();
    assert!(old.success());
    let cbm = slow(t.path(), 0);
    cbm.reindex("/r", "proj", Instant::now() + Duration::from_secs(30))
        .unwrap();
    assert!(t.path().join("finished").exists());
}

#[test]
fn an_index_past_the_time_left_is_not_killed_and_frees_the_lock_when_it_ends() {
    let t = tempfile::tempdir().unwrap();
    let cbm = slow(t.path(), 2);
    let start = Instant::now();
    let why = cbm
        .reindex("/r", "proj", start + Duration::from_millis(300))
        .unwrap_err();
    assert!(matches!(why, CbmError::StillIndexing(_)), "{why}");
    assert!(
        why.to_string().contains("goes on in the background"),
        "{why}"
    );
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "it waited for the index"
    );
    assert!(lock(t.path()).exists(), "the running index lost its lock");
    assert!(
        eventually(|| t.path().join("finished").exists()),
        "the index was killed"
    );
    assert!(
        eventually(|| !lock(t.path()).exists()),
        "the lock outlived the index"
    );
}

#[test]
fn a_stop_leaves_the_index_running() {
    let t = tempfile::tempdir().unwrap();
    let cancel = Cancel::default();
    let cbm = slow(t.path(), 2).stopped_by(&cancel);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        cancel.cancel();
    });
    let why = cbm
        .reindex("/r", "proj", Instant::now() + Duration::from_secs(30))
        .unwrap_err();
    assert!(matches!(why, CbmError::Stopped), "{why}");
    assert!(
        eventually(|| t.path().join("finished").exists()),
        "the index was killed"
    );
    assert!(
        eventually(|| !lock(t.path()).exists()),
        "the lock outlived the index"
    );
}
