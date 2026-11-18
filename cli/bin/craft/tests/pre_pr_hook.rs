//! `craft hook pre-pr` as the harness runs it: the `PreToolUse` input on stdin, a real repository,
//! a run store as the record writer lays it out; the output read back as the harness reads it.
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the fixture helpers fail the test loudly, like the tests they serve"
)]

use std::io::Write as _;
use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::{Value, json};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}");
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

/// A repository on `feat/x` with one commit; its HEAD.
fn repo(d: &Path) -> String {
    git(d, &["init", "-q", "-b", "feat/x"]);
    std::fs::write(d.join("a"), "a\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "init"]);
    git(d, &["rev-parse", "HEAD"])
}

/// Files a review run into `store` as the record writer does: an index line and its detail file.
fn file_run(store: &Path, project: &Path, head: &str, verdict: &str, scope: &str) {
    std::fs::create_dir_all(store).unwrap();
    let ts = "2026-11-01T10-00-00Z";
    let line = json!({"ts": ts, "kind": "workflow", "name": "review", "nested": false,
        "project": project.canonicalize().unwrap(), "branch": "feat/x", "head": head, "verdict": verdict});
    let mut detail = line.clone();
    detail["lensScope"] = json!(scope);
    let mut index = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(store.join("index.jsonl"))
        .unwrap();
    writeln!(index, "{line}").unwrap();
    std::fs::write(
        store.join(format!("{ts}-workflow-review.json")),
        detail.to_string(),
    )
    .unwrap();
}

/// The hook run on `command` from `cwd`; its stdout parsed, `null` when empty.
fn hook(cwd: &Path, store: &Path, command: &str) -> Value {
    let input = json!({"session_id": "s", "transcript_path": "/t", "cwd": cwd,
        "hook_event_name": "PreToolUse", "tool_name": "Bash",
        "tool_input": {"command": command}, "tool_use_id": "u"});
    let mut child = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(["hook", "pre-pr", "--store"])
        .arg(store)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "the hook exits 0");
    let text = String::from_utf8(out.stdout).unwrap();
    if text.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&text).unwrap()
    }
}

#[test]
fn a_pr_on_an_unreviewed_head_is_warned_and_a_reviewed_one_is_not() {
    let d = tempfile::tempdir().unwrap();
    let r = d.path().join("r");
    std::fs::create_dir(&r).unwrap();
    let head = repo(&r);
    let store = d.path().join("store");

    assert_eq!(
        hook(&r, &store, "git status"),
        Value::Null,
        "not a PR: silent"
    );
    let warned = hook(&r, &store, "rtk gh pr create --fill");
    assert!(
        warned["systemMessage"]
            .as_str()
            .unwrap()
            .contains("could not check")
    );

    file_run(&store, &r, &head, "Warning", "delta");
    let warned = hook(&r, &store, "gh pr create --fill");
    assert_eq!(warned["hookSpecificOutput"]["hookEventName"], "PreToolUse");
    let human = warned["systemMessage"].as_str().unwrap();
    assert!(
        human.contains("no full craft review on this head"),
        "{human}"
    );
    assert!(human.contains(head.get(..12).unwrap()), "{human}");
    assert!(human.contains("Warning, delta"), "{human}");

    file_run(&store, &r, &head, "Block", "full");
    assert_eq!(
        hook(&r, &store, "gh pr create --fill"),
        Value::Null,
        "reviewed: silent"
    );
}

#[test]
fn a_linked_worktree_finds_the_run_filed_under_its_main_checkout() {
    let d = tempfile::tempdir().unwrap();
    let r = d.path().join("r");
    std::fs::create_dir(&r).unwrap();
    repo(&r);
    let wt = d.path().join("wt");
    git(
        &r,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feat/y",
            wt.to_str().unwrap(),
        ],
    );
    std::fs::write(wt.join("b"), "b\n").unwrap();
    git(&wt, &["add", "."]);
    git(&wt, &["commit", "-qm", "b"]);
    let store = d.path().join("store");
    file_run(
        &store,
        &r,
        &git(&wt, &["rev-parse", "HEAD"]),
        "Approve",
        "full",
    );
    assert!(
        !hook(&r, &store, "gh pr create").is_null(),
        "the main checkout's head is another"
    );
    assert_eq!(hook(&r, &store, "cd ../wt && gh pr create"), Value::Null);
    let from_elsewhere = format!("cd {} && gh pr create", wt.display());
    assert_eq!(hook(d.path(), &store, &from_elsewhere), Value::Null);
}
