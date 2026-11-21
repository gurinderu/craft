//! A running index touches its lock, so the stale age measures silence, not the index's whole
//! time (realm @nick/craft, node #530).

use std::time::{Duration, Instant};

use super::lock::{eventually, lock, slow};
use crate::consumers::cbm::{Cbm, CbmError};

#[test]
fn a_running_index_keeps_its_lock_fresh_so_only_silence_ages_it() {
    let t = tempfile::tempdir().unwrap();
    let first = Cbm {
        lock_stale: Duration::from_millis(800),
        heartbeat: Duration::from_millis(200),
        ..slow(t.path(), 3)
    };
    let second = first.clone();
    // The first index runs past its own time and goes on in the background, holding the lock.
    let why = first
        .reindex("/r", "proj", Instant::now() + Duration::from_millis(100))
        .unwrap_err();
    assert!(matches!(why, CbmError::StillIndexing(_)), "{why}");
    // Older than the stale age by now, yet touched: the second waits and does not take it over.
    let why = second
        .reindex("/r", "proj", Instant::now() + Duration::from_millis(1800))
        .unwrap_err();
    assert!(matches!(why, CbmError::Locked { .. }), "taken over: {why}");
    assert!(
        eventually(|| !lock(t.path()).exists()),
        "the lock outlived the index"
    );
}

/// How long ago the lock at `dir` was last touched.
fn age(dir: &std::path::Path) -> Duration {
    let at = std::fs::metadata(dir).unwrap().modified().unwrap();
    std::time::SystemTime::now()
        .duration_since(at)
        .unwrap_or_default()
}

#[test]
fn a_lock_held_past_its_cap_is_given_up_and_the_index_left_running() {
    let t = tempfile::tempdir().unwrap();
    let cbm = Cbm {
        heartbeat: Duration::from_millis(100),
        lock_cap: Duration::from_millis(800),
        ..slow(t.path(), 3)
    };
    let why = cbm
        .reindex("/r", "proj", Instant::now() + Duration::from_millis(100))
        .unwrap_err();
    assert!(matches!(why, CbmError::StillIndexing(_)), "{why}");
    assert!(
        eventually(|| !lock(t.path()).exists()),
        "the lock was not given up"
    );
    assert!(
        !t.path().join("finished").exists(),
        "the index was waited for"
    );
    assert!(
        eventually(|| t.path().join("finished").exists()),
        "the index was killed"
    );
}

#[test]
fn a_killed_index_run_no_longer_touches_its_lock() {
    let t = tempfile::tempdir().unwrap();
    let cbm = Cbm {
        heartbeat: Duration::from_millis(100),
        ..slow(t.path(), 4)
    };
    cbm.reindex("/r", "proj", Instant::now() + Duration::from_millis(100))
        .unwrap_err();
    let dir = lock(t.path()).display().to_string();
    // The index run's `sh` is the oldest process naming the lock.
    let sh = std::process::Command::new("pgrep")
        .args(["-o", "-f", &dir])
        .output()
        .unwrap();
    let pid = String::from_utf8(sh.stdout).unwrap().trim().to_owned();
    assert!(!pid.is_empty(), "no index run");
    let killed = std::process::Command::new("kill")
        .args(["-KILL", &pid])
        .status()
        .unwrap();
    assert!(killed.success());
    std::thread::sleep(Duration::from_millis(700));
    assert!(
        age(&lock(t.path())) >= Duration::from_millis(400),
        "still touched"
    );
}
