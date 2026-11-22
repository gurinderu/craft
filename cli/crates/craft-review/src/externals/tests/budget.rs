//! The engine's budgets: a record's `versionMatch` gets a fixed one and is refused for its record;
//! discovery's own patterns get one scaled to the manifest, and a manifest past it is unread alone.

use super::{discover, put};
use serde_json::json;
use std::path::Path;
use std::time::{Duration, Instant};

/// About `bytes` of a values file: many plain keys, one image the walk should find.
fn values_of(bytes: usize) -> String {
    let mut text = String::from("image: ghcr.io/acme/app:v1.2.3\n");
    let mut i = 0;
    while text.len() < bytes - 64 {
        text.push_str(&format!("key{i}: \"value {i} # not a comment\"\n"));
        i += 1;
    }
    text
}

/// How long `runs` discoveries of `root`'s `values.yaml` take back to back; each must find the
/// image with nothing unread.
fn timed(root: &Path, runs: u32) -> Duration {
    let started = Instant::now();
    for _ in 0..runs {
        let got = discover(root, Some(&["values.yaml"]), json!([]));
        // The absolute ceiling: every call stayed inside the engine's own per-call budget (the
        // 2 s floor plus a second per whole 64 KiB, 17 s for the 1 MiB file) or the manifest would
        // be unread. It is the only check that catches a constant-factor slowdown, and only once
        // that slowdown crosses the budget: on a loaded host nothing independent of the load can
        // catch one earlier.
        assert_eq!(got["unread"], json!([]));
        assert_eq!(got["candidates"][0]["system"], "app");
    }
    started.elapsed()
}

#[test]
fn a_one_mib_manifest_is_discovered_under_the_engine_budgets() {
    let (small, large) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    put(small.path(), "values.yaml", values_of(64 * 1024));
    put(large.path(), "values.yaml", values_of(1024 * 1024));
    // Super-linear growth, on the Rust side or in the patterns, is pinned by a ratio taken under
    // whatever load the host has: one 1 MiB discovery against sixteen 64 KiB ones back to back,
    // the same bytes in windows of the same length, interleaved, each the fastest of three. Linear
    // work keeps the ratio near 1: measured 0.80 to 0.82 idle, 0.54 to 1.03 under 160 busy loops
    // on 16 cores. The bound of 2 sits twice above those, and fails once a quadratic term costs at
    // 1 MiB from about once (loaded) to one and a half times (idle) the linear work. A
    // constant-factor slowdown moves both sides alike and leaves the ratio where it was: only the
    // ceiling in `timed` catches it.
    let (mut one, mut sixteen) = (Duration::MAX, Duration::MAX);
    for _ in 0..3 {
        one = one.min(timed(large.path(), 1));
        sixteen = sixteen.min(timed(small.path(), 16));
    }
    assert!(
        one < sixteen * 2,
        "1 MiB took {one:?}, sixteen 64 KiB {sixteen:?}: past twice linear"
    );
}

#[test]
fn a_manifest_past_discoverys_budget_is_unread_and_the_next_is_still_read() {
    let root = tempfile::tempdir().unwrap();
    // One long run of blanks inside a value: the key pattern's lazy value, retried before its
    // trailing blanks at every one of them, goes quadratic over it.
    put(
        root.path(),
        "slow/values.yaml",
        format!("a: x{}y\n", " ".repeat(100_000)),
    );
    put(
        root.path(),
        "values.yaml",
        "image: ghcr.io/acme/app:v1.2.3\n",
    );
    let got = discover(
        root.path(),
        Some(&["slow/values.yaml", "values.yaml"]),
        json!([]),
    );
    assert_eq!(
        got["unread"],
        json!([{"file": "slow/values.yaml", "error": "discovery's manifest patterns ran past their budget of 3 s — refused"}])
    );
    assert_eq!(got["candidates"][0]["system"], "app");
}
