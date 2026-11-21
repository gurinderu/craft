//! `--delta` over the branch point from the command line: `review start` refuses it as an argument
//! is refused (exit 2, the reason on stderr, nothing on stdout), and `review run` stops before any
//! task with the reason, its host never started.
#![expect(
    clippy::unwrap_used,
    reason = "the fixture helpers fail the test loudly, like the tests they serve"
)]

mod common;

use std::path::Path;
use std::process::{Command, Output};

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
fn branch(code: &Path) {
    std::fs::create_dir_all(code.join("src")).unwrap();
    git(code, &["init", "-q", "-b", "main"]);
    std::fs::write(code.join("README.md"), "x\n").unwrap();
    git(code, &["add", "."]);
    git(code, &["commit", "-qm", "init"]);
    git(code, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    std::fs::write(code.join("src/lib.rs"), "pub fn f() -> u8 { 1 }\n").unwrap();
    git(code, &["add", "."]);
    git(code, &["commit", "-qm", "feat: add f"]);
}

fn craft(args: &[&str], code: &Path, home: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_craft"))
        .env("CRAFT_CODE_GRAPH", "")
        .args(args)
        .args(["--no-recall", "--no-gate", "--delta", "--cwd"])
        .arg(code)
        .env("HOME", home)
        .output()
        .unwrap()
}

#[test]
fn start_refuses_delta_over_the_branch_point_as_an_argument() {
    let tmp = tempfile::tempdir().unwrap();
    let code = tmp.path().join("repo");
    branch(&code);
    let run = tmp.path().join("run");
    let mut args = vec!["review", "start", "--run-dir", run.to_str().unwrap()];
    args.extend(["--base", "origin/main"]);
    let out = craft(&args, &code, tmp.path());
    assert_eq!(out.status.code(), Some(2), "{out:?}");
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.starts_with("craft: --delta "), "{err}");
    assert!(err.contains("earlier review"), "{err}");
    assert!(out.stdout.is_empty());
    assert!(!run.join("state.json").exists());
}

#[test]
fn run_stops_before_any_task_with_the_reason() {
    let tmp = tempfile::tempdir().unwrap();
    let code = tmp.path().join("repo");
    branch(&code);
    // A host that would leave a mark had any task reached it.
    let host = tmp.path().join("codex");
    let mark = tmp.path().join("ran");
    common::write_executable(&host, &format!("#!/bin/sh\ntouch '{}'\n", mark.display())).unwrap();
    let checkout = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut args = vec!["review", "run", "--backend", "codex", "--host-bin"];
    args.push(host.to_str().unwrap());
    args.extend(["--craft-root", checkout.to_str().unwrap()]);
    let out = craft(&args, &code, tmp.path());
    let said = String::from_utf8_lossy(&out.stdout);
    assert_ne!(out.status.code(), Some(0), "{said}");
    assert!(said.contains("--delta "), "{said}");
    assert!(said.contains("earlier review"), "{said}");
    assert!(!mark.exists(), "no task ran");
}
