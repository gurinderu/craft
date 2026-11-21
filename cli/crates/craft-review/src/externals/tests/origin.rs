use super::{discover, put};
use serde_json::json;
use std::process::Command;

#[test]
fn actual_git_origin_suppresses_only_matching_repo_identity() {
    let root = tempfile::tempdir().unwrap();
    for args in [
        vec!["init", "-q"],
        vec![
            "remote",
            "add",
            "origin",
            "https://user:password@github.com/acme/my-app.git",
        ],
    ] {
        let output = Command::new("git")
            .arg("-C")
            .arg(root.path())
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", root.path().join("no-config"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    put(
        root.path(),
        "values.yaml",
        "image: ghcr.io/ACME/my-app:v1\nimage: containers.example/snapshot/my-app:main\nimage: ghcr.io/acme/other:v2\n",
    );
    // Per-file system dedup precedes origin filtering, even when it drops the first entry.
    let got = discover(root.path(), None, json!([]));
    assert_eq!(got["candidates"].as_array().unwrap().len(), 1);
    assert_eq!(got["candidates"][0]["system"], "other");
    put(
        root.path(),
        "values.yaml",
        "image: containers.example/snapshot/my-app:main\n",
    );
    let got = discover(root.path(), None, json!([]));
    assert_eq!(got["candidates"][0]["system"], "my-app");
    assert_eq!(got["candidates"][0]["repo"], "");
    assert_eq!(got["candidates"][0]["version"], "main");
}
