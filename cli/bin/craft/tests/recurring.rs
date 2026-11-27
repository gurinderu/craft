//! Public executable acceptance on isolated stores, with no Node executable in PATH (#205).
#![expect(clippy::unwrap_used, reason = "fixtures fail loudly")]

#[path = "recurring/bounds.rs"]
mod bounds;
#[path = "recurring/flags.rs"]
mod flags;
#[path = "recurring/selection.rs"]
mod selection;
#[path = "recurring/support.rs"]
mod support;
#[path = "recurring/unverified.rs"]
mod unverified;
#[path = "recurring/utf16.rs"]
mod utf16;

use serde_json::json;
use support::{Store, row};

#[test]
fn executable_groups_branches_not_runs_or_projects_and_always_emits_one_object() {
    let s = Store::new();
    let r = row("src/a.rs", "unwrap in parser may panic");
    s.record("1", "feat/a", json!([r]));
    s.record("2", "feat/a", json!([r]));
    let other = json!({"project":"elsewhere", "branch":"feat/b", "ledger":[r]});
    s.write("3", &other);
    assert_eq!(s.read(&[])["groups"], json!([]));
    let mut second = row("src/a.rs", "parser unwrap may panic");
    second["severity"] = json!("High");
    s.record("4", "feat/b", json!([second]));
    let out = s.read(&[]);
    assert_eq!(out["skipped"]["otherProject"], 1);
    assert_eq!(out["groups"][0]["branches"], json!(["feat/a", "feat/b"]));
    assert_eq!(
        out["groups"][0]["runs"],
        json!(["1.json", "2.json", "4.json"])
    );
    assert_eq!(out["groups"][0]["severities"], json!(["High", "Medium"]));
    assert_eq!(out, s.read(&["--json"]));
    assert!(!s.store.join("index.jsonl").exists());
}

#[test]
fn repeatable_paths_are_segment_prefixes_and_keep_the_given_spelling() {
    let s = Store::new();
    for branch in ["a", "b"] {
        s.record(
            branch,
            branch,
            json!([
                row("src/a.rs", "same"),
                row("src2/b.rs", "same"),
                row("lib/a.rs", "same"),
                row("src/../b.rs", "same")
            ]),
        );
    }
    let out = s.read(&["--path", "./src//", "--path", "lib\\a.rs"]);
    let files: Vec<_> = out["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["file"].as_str().unwrap())
        .collect();
    assert_eq!(files, ["lib/a.rs", "src/../b.rs", "src/a.rs"]);
    assert_eq!(out["paths"], json!(["./src//", "lib\\a.rs"]));
    assert_eq!(
        s.read(&["--path", "src/../b.rs"])["groups"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn project_defaults_to_cwd_and_linked_worktrees_share_the_main_key() {
    let s = Store::new();
    for args in [
        &["init"][..],
        &[
            "-c",
            "user.name=fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "--allow-empty",
            "-m",
            "fixture",
        ],
    ] {
        assert!(
            std::process::Command::new("git")
                .args(args)
                .current_dir(&s.project)
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    let linked = s.root.path().join("linked");
    assert!(
        std::process::Command::new("git")
            .args(["worktree", "add", "--detach"])
            .arg(&linked)
            .current_dir(&s.project)
            .output()
            .unwrap()
            .status
            .success()
    );
    s.record("1", "a", json!([row("f", "same")]));
    s.record("2", "b", json!([row("f", "same")]));
    let result = s
        .command()
        .current_dir(&linked)
        .args(["runs", "--json", "--store"])
        .arg(&s.store)
        .arg("recurring")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let out: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(out["project"], json!(s.project));
    assert_eq!(out["groups"].as_array().unwrap().len(), 1);
}
