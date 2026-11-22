//! The engine's budgets: a record's `versionMatch` gets a fixed one and is refused for its record;
//! discovery's own patterns get one scaled to the manifest, and a manifest past it is unread alone.

use super::{discover, put};
use serde_json::json;
use std::time::Instant;

/// About 1 MiB of a values file: many plain keys, one image the walk should find.
fn large_values() -> String {
    let mut text = String::from("image: ghcr.io/acme/app:v1.2.3\n");
    let mut i = 0;
    while text.len() < 1024 * 1024 - 64 {
        text.push_str(&format!("key{i}: \"value {i} # not a comment\"\n"));
        i += 1;
    }
    text
}

#[test]
fn a_one_mib_manifest_is_discovered_under_the_engine_budgets() {
    let root = tempfile::tempdir().unwrap();
    put(root.path(), "values.yaml", large_values());
    let started = Instant::now();
    let got = discover(root.path(), Some(&["values.yaml"]), json!([]));
    // Well inside the 2 s floor of its budget: the patterns are linear over ordinary lines.
    assert!(
        started.elapsed() < super::super::pattern::CALL_BUDGET,
        "{:?}",
        started.elapsed()
    );
    assert_eq!(got["unread"], json!([]));
    assert_eq!(got["candidates"][0]["system"], "app");
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
