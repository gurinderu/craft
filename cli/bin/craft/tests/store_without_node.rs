//! A run's telemetry lands with no node on the PATH and no plugin root: the binary writes the run
//! store itself (realm @nick/craft, node #539).
#![cfg(unix)]

mod store_fixture;

use std::path::Path;

use store_fixture::{started, submit};

#[test]
fn a_run_started_with_no_node_and_no_plugin_root_files_its_start_checkpoint() {
    let tmp = tempfile::tempdir().unwrap();
    let (_, home, _, out) = started(tmp.path());
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let step: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(step["filing"]["lost"], serde_json::json!([]), "{step}");
    let dir = step["filing"]["runDir"].as_str().unwrap();
    assert!(
        dir.starts_with(&home.join(".craft/runs/.partial").display().to_string()),
        "{dir}"
    );
    let slice = std::fs::read_to_string(Path::new(dir).join("00-start.json")).unwrap();
    assert!(slice.contains("\"phase\": \"start\""), "{slice}");
    assert!(slice.contains("\"driver\": \"cli\""), "{slice}");
}

#[test]
fn a_submits_tokens_and_their_scope_are_kept_for_the_runs_record() {
    let tmp = tempfile::tempdir().unwrap();
    let (run, home, path, out) = started(tmp.path());
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let flags = [
        "--output-tokens",
        "1234",
        "--output-tokens-scope",
        "turn-delta",
    ];
    let said = submit(&run, &home, &path, &flags);
    assert!(
        said.status.success(),
        "{}",
        String::from_utf8_lossy(&said.stderr)
    );
    let kept: serde_json::Value =
        serde_json::from_slice(&std::fs::read(run.join("filing.json")).unwrap()).unwrap();
    assert_eq!(
        (&kept["outputTokens"], &kept["outputTokensScope"]),
        (&serde_json::json!(1234), &serde_json::json!("turn-delta")),
        "{kept}"
    );
}

#[test]
fn a_scope_without_its_tokens_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let (run, home, path, _) = started(tmp.path());
    let said = submit(&run, &home, &path, &["--output-tokens-scope", "turn-delta"]);
    assert!(!said.status.success());
    let err = String::from_utf8_lossy(&said.stderr);
    assert!(err.contains("--output-tokens"), "{err}");
}
