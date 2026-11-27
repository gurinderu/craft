//! `review start` reads the reviewer's profile's `[project]` section (realm @nick/craft, node #654):
//! a section written by hand reaches the run's state and notes, as its `[lenses]` does beside it; one it cannot read is named and
//! the run goes on as if it were absent. HOME is a temporary directory holding the profile.
#![expect(
    clippy::unwrap_used,
    reason = "the fixture helpers fail the test loudly, like the tests they serve"
)]

use std::path::Path;
use std::process::{Command, Output};

use serde_json::{Value, json};

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

/// A repository whose branch adds `src/lib.rs` over `origin/main`.
fn repo(t: &Path) -> std::path::PathBuf {
    let code = t.join("repo");
    std::fs::create_dir_all(code.join("src")).unwrap();
    git(&code, &["init", "-q", "-b", "main"]);
    std::fs::write(code.join("README.md"), "x\n").unwrap();
    git(&code, &["add", "."]);
    git(&code, &["commit", "-qm", "init"]);
    git(&code, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    std::fs::write(code.join("src/lib.rs"), "pub fn f() -> u8 { 1 }\n").unwrap();
    git(&code, &["add", "."]);
    git(&code, &["commit", "-qm", "feat: add f"]);
    code
}

fn craft(t: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(args)
        .env("HOME", t.join("home"))
        .env("CRAFT_CODE_GRAPH", "")
        .env_remove("CRAFT_ROOT")
        .output()
        .unwrap()
}

/// The state a `review start` over `code` leaves, its profile holding `section` beside what
/// `init --write` wrote and `lenses` in the `[lenses]` table that wrote.
fn started(section: &str, lenses: &str) -> Value {
    let tmp = tempfile::tempdir().unwrap();
    let t = tmp.path();
    let code = repo(t);
    let wrote = craft(t, &["init", "--write", "--cwd", code.to_str().unwrap()]);
    assert!(wrote.status.success(), "{wrote:?}");
    let profile: Value = serde_json::from_slice(&wrote.stdout).unwrap();
    let path = profile.get("profile").and_then(Value::as_str).unwrap();
    let text = std::fs::read_to_string(path).unwrap();
    assert!(text.contains("[lenses]\n"), "{text}");
    let text = text.replace("[lenses]\n", &format!("[lenses]\n{lenses}"));
    std::fs::write(path, format!("{text}\n{section}")).unwrap();
    let run = t.join("run");
    let out = craft(
        t,
        &[
            "review",
            "start",
            "--run-dir",
            run.to_str().unwrap(),
            "--base",
            "origin/main",
            "--no-recall",
            "--no-gate",
            "--cwd",
            code.to_str().unwrap(),
        ],
    );
    assert!(out.status.success(), "{out:?}");
    serde_json::from_str(&std::fs::read_to_string(run.join("state.json")).unwrap()).unwrap()
}

fn notes(state: &Value) -> String {
    state["notes"].to_string()
}

#[test]
fn a_hand_written_project_section_reaches_the_run() {
    let state = started(
        "[project]\nlibrary = false\nsecurity_paths = [\"src\"]\n",
        "\"rust:money\" = \"off\"\n",
    );
    assert_eq!(
        state["context"]["project"],
        json!({"library": false, "security_paths": ["src"]})
    );
    assert!(
        notes(&state).contains("library: no; security paths: src"),
        "{}",
        notes(&state)
    );
    assert_eq!(
        state["context"]["composition"]["off"],
        json!(["rust:money"]),
        "the [lenses] section beside it, read the same way"
    );
}

#[test]
fn a_project_section_it_cannot_read_is_named_and_set_aside() {
    let state = started("[project]\nlibary = true\n", "");
    assert_eq!(state["context"].get("project"), None);
    assert!(
        notes(&state).contains("[project] section could not be read"),
        "{}",
        notes(&state)
    );
}
