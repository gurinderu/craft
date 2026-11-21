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
