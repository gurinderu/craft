//! What the dead agents of `craft review run` wrote reaches the binary's stop (realm @nick/craft,
//! node #666): a lens round whose every agent died is stopped naming what they said, not with a
//! guess at the cause — through the run's own submits, and through `review submit --died`.
#![cfg(unix)]
#![expect(
    clippy::unwrap_used,
    reason = "the fixture helpers fail the test loudly, like the tests they serve"
)]

mod common;

use std::path::Path;
use std::process::{Command, Output};

use serde_json::{Value, json};

const SAID: &str = "the stand-in host refuses every task";
const GUESS: &str = "most likely the account's usage limit or an outage";

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .unwrap();
    assert!(ok.status.success(), "git {args:?}");
}

/// A repository whose branch changes `src/lib.rs` over `origin/main`.
fn branch(code: &Path) {
    std::fs::create_dir_all(code.join("src")).unwrap();
    git(code, &["init", "-q", "-b", "main"]);
    std::fs::write(code.join("src/lib.rs"), "pub fn f() -> u8 { 0 }\n").unwrap();
    git(code, &["add", "."]);
    git(code, &["commit", "-qm", "init"]);
    git(code, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    std::fs::write(code.join("src/lib.rs"), "pub fn f() -> u8 { 1 }\n").unwrap();
    git(code, &["commit", "-qam", "feat: f"]);
}

fn craft(home: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(args)
        .env("HOME", home)
        .env("CRAFT_CODE_GRAPH", "")
        .env_remove("CLAUDE_PLUGIN_ROOT")
        .env_remove("CRAFT_ROOT")
        .output()
        .unwrap()
}

#[test]
fn a_run_whose_agents_all_die_stops_naming_what_they_wrote() {
    let tmp = tempfile::tempdir().unwrap();
    let (code, home) = (tmp.path().join("repo"), tmp.path().join("home"));
    branch(&code);
    let host = tmp.path().join("codex");
    let script = format!("#!/bin/sh\ncat > /dev/null\necho '{SAID}' >&2\nexit 1\n");
    common::write_executable(&host, &script).unwrap();
    let checkout = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut args = vec!["review", "run", "--backend", "codex", "--no-recall"];
    args.extend(["--no-gate", "--depth", "light", "--base", "origin/main"]);
    args.extend(["--host-bin", host.to_str().unwrap(), "--cwd"]);
    args.extend([code.to_str().unwrap(), "--craft-root"]);
    args.push(checkout.to_str().unwrap());
    let out = craft(&home, &args);
    let said = String::from_utf8_lossy(&out.stdout);
    assert_ne!(out.status.code(), Some(0), "{said}");
    assert!(said.contains("died with no answer; of "), "{said}");
    assert!(said.contains(&format!("said `{SAID}`")), "{said}");
    assert!(!said.contains(GUESS), "{said}");
}

/// The step a submit of the run in `run` with no answer and `died` printed.
fn submitted(home: &Path, run: &Path, died: &[String]) -> Value {
    let none = run.join("none.json");
    std::fs::write(&none, "{}").unwrap();
    let mut args = vec!["review", "submit", "--run", run.to_str().unwrap()];
    args.extend(["--answers", none.to_str().unwrap()]);
    for d in died {
        args.extend(["--died", d.as_str()]);
    }
    let out = craft(home, &args);
    assert!(out.status.success(), "{out:?}");
    serde_json::from_slice(&out.stdout).unwrap()
}

#[test]
fn review_submit_died_names_what_the_dead_agents_wrote() {
    let tmp = tempfile::tempdir().unwrap();
    let (code, home) = (tmp.path().join("repo"), tmp.path().join("home"));
    branch(&code);
    let run = tmp.path().join("run");
    let mut args = vec!["review", "start", "--no-recall", "--no-gate", "--cwd"];
    args.extend([code.to_str().unwrap(), "--run-dir", run.to_str().unwrap()]);
    assert!(craft(&home, &args).status.success());
    // The scouts die too: the plan is the conservative fallback, and the lens round follows.
    let mut s = submitted(&home, &run, &[]);
    for _ in 0..4 {
        if s["tasks"][0]["id"].as_str().unwrap().starts_with("lens-") {
            break;
        }
        s = submitted(&home, &run, &[]);
    }
    for _ in 0..3 {
        let tasks = s["tasks"].as_array().unwrap().iter();
        let died: Vec<String> = tasks
            .map(|t| format!("{}={SAID}", t["id"].as_str().unwrap()))
            .collect();
        s = submitted(&home, &run, &died);
        if s["done"] == json!(true) {
            break;
        }
    }
    assert_eq!(s["verdict"], json!("INCOMPLETE"), "{s}");
    let line = s["line"].as_str().unwrap();
    assert!(line.contains(&format!("said `{SAID}`")), "{line}");
    assert!(!line.contains(GUESS), "{line}");
}
