//! How a review's start runs the change's mutants (realm @nick/craft, nodes #645, #648): this binary
//! is their worker, its hidden `__craft-mutants` command writing what it came to; the reviewer's
//! profile's `[mutants]` turns them off or names their budget, and `--no-gate` runs none. The gate's
//! cargo and cargo-mutants are a stand-in on the PATH; HOME is a temporary directory.
#![cfg(unix)]
#![expect(
    clippy::unwrap_used,
    reason = "the fixture helpers fail the test loudly, like the tests they serve"
)]

mod common;

use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

/// A cargo whose every command passes, `mutants --version` answering as cargo-mutants.
const CARGO: &str = "#!/bin/sh\n[ \"$1 $2\" = 'mutants --version' ] && { echo 'cargo-mutants 27.1.0'; exit 0; }\nexit 0\n";

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

/// A Cargo package under `t` whose branch changes `src/lib.rs` over `origin/main`, its reviewer's
/// profile holding `mutants` as its `[mutants]` section; the checkout and the home.
fn package(t: &Path, mutants: &str) -> (PathBuf, PathBuf) {
    let (code, home) = (t.join("repo"), t.join("home"));
    std::fs::create_dir_all(code.join("src")).unwrap();
    git(&code, &["init", "-q", "-b", "main"]);
    std::fs::write(
        code.join("Cargo.toml"),
        "[package]\nname = \"f\"\nversion = \"0.1.0\"\n",
    )
    .unwrap();
    std::fs::write(code.join("src/lib.rs"), "pub fn f() -> u8 { 0 }\n").unwrap();
    git(&code, &["add", "."]);
    git(&code, &["commit", "-qm", "init"]);
    git(&code, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    std::fs::write(code.join("src/lib.rs"), "pub fn f() -> u8 { 1 }\n").unwrap();
    git(&code, &["commit", "-qam", "feat: f"]);
    let out = craft(t, &["init", "--write", "--cwd", code.to_str().unwrap()]);
    assert!(out.status.success(), "{out:?}");
    let written: Value = serde_json::from_slice(&out.stdout).unwrap();
    let profile = written.get("profile").and_then(Value::as_str).unwrap();
    let text = std::fs::read_to_string(profile).unwrap();
    std::fs::write(profile, format!("{text}\n[mutants]\n{mutants}\n")).unwrap();
    (code, home)
}

/// craft with the stand-in cargo first on the PATH, HOME `t/home`.
fn craft(t: &Path, args: &[&str]) -> Output {
    let bin = t.join("bin");
    if !bin.join("cargo").exists() {
        std::fs::create_dir_all(&bin).unwrap();
        common::write_executable(&bin.join("cargo"), CARGO).unwrap();
    }
    let path = std::env::join_paths(
        std::iter::once(bin).chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
    )
    .unwrap();
    Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(args)
        .env("HOME", t.join("home"))
        .env("PATH", path)
        .env("CRAFT_CODE_GRAPH", "")
        .env_remove("CRAFT_ROOT")
        .output()
        .unwrap()
}

/// The state of the run `review start` opened over `code` with `extra`, and its directory.
fn started(t: &Path, code: &Path, extra: &[&str]) -> (Value, PathBuf) {
    let run = t.join("run");
    let mut args = vec!["review", "start", "--no-recall", "--cwd"];
    args.extend([code.to_str().unwrap(), "--run-dir", run.to_str().unwrap()]);
    args.extend(extra);
    let out = craft(t, &args);
    assert!(out.status.success(), "{out:?}");
    let state = std::fs::read_to_string(run.join("state.json")).unwrap();
    (serde_json::from_str(&state).unwrap(), run)
}

fn notes(state: &Value) -> String {
    let all = state["notes"].as_array().unwrap().iter();
    all.filter_map(Value::as_str).collect::<Vec<_>>().join("\n")
}

#[test]
fn the_profiles_budget_reaches_the_worker_this_binary_runs() {
    let tmp = tempfile::tempdir().unwrap();
    let (code, _home) = package(tmp.path(), "budget_secs = 77");
    let (state, run) = started(tmp.path(), &code, &[]);
    assert_eq!(state["gate"]["mutants"]["dir"], json!(run.join("mutants")));
    assert_eq!(state["context"]["mutants"], json!(true));
    let request = std::fs::read_to_string(run.join("mutants/request.json")).unwrap();
    let request: Value = serde_json::from_str(&request).unwrap();
    assert_eq!(request["budgetSecs"], json!(77));
    // The worker is `__craft-mutants`: it writes what it came to, here the stand-in's no outcomes.
    let result = run.join("mutants/result.json");
    let deadline = Instant::now() + Duration::from_secs(30);
    while !result.exists() {
        assert!(Instant::now() < deadline, "the worker wrote no result");
        std::thread::sleep(Duration::from_millis(50));
    }
    let came: Value = serde_json::from_str(&std::fs::read_to_string(result).unwrap()).unwrap();
    assert_eq!(came["ran"], json!("broken"), "{came}");
}

#[test]
fn off_in_the_profile_or_no_gate_launches_no_worker_and_says_why() {
    for (mutants, extra, why) in [
        (
            "off = true",
            &[][..],
            "did not run: off in the reviewer's profile",
        ),
        (
            "",
            &["--no-gate"][..],
            "did not run: the run ran no gate of its own",
        ),
    ] {
        let tmp = tempfile::tempdir().unwrap();
        let (code, _home) = package(tmp.path(), mutants);
        let (state, run) = started(tmp.path(), &code, extra);
        assert!(notes(&state).contains(why), "{why}: {}", notes(&state));
        assert_eq!(state["context"]["mutants"], Value::Null, "{why}");
        assert!(!run.join("mutants/request.json").exists(), "{why}");
    }
}

#[test]
fn the_hidden_worker_command_writes_a_result_for_a_request_it_cannot_read() {
    let tmp = tempfile::tempdir().unwrap();
    let out = craft(
        tmp.path(),
        &["__craft-mutants", tmp.path().to_str().unwrap()],
    );
    assert!(out.status.success(), "{out:?}");
    let came = std::fs::read_to_string(tmp.path().join("result.json")).unwrap();
    let came: Value = serde_json::from_str(&came).unwrap();
    assert_eq!(came["ran"], json!("broken"));
    assert!(
        came["message"].as_str().unwrap().contains("request.json"),
        "{came}"
    );
}
