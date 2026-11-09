//! `craft review comment` from the command line: a run the binary has not finished is refused in
//! its own words, with nothing posted, and the exit every error reports.
#![expect(
    clippy::unwrap_used,
    reason = "the fixture helpers fail the test loudly, like the tests they serve"
)]

use std::path::Path;
use std::process::Command;

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

#[test]
fn a_run_not_finished_is_refused_with_nothing_posted() {
    let tmp = tempfile::tempdir().unwrap();
    let (code, run) = (tmp.path().join("repo"), tmp.path().join("run"));
    std::fs::create_dir_all(code.join("src")).unwrap();
    git(&code, &["init", "-q", "-b", "main"]);
    std::fs::write(code.join("README.md"), "x\n").unwrap();
    git(&code, &["add", "."]);
    git(&code, &["commit", "-qm", "init"]);
    git(&code, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    std::fs::write(code.join("src/lib.rs"), "pub fn f() -> u8 { 1 }\n").unwrap();
    git(&code, &["add", "."]);
    git(&code, &["commit", "-qm", "feat: add f"]);
    let craft = env!("CARGO_BIN_EXE_craft");
    let started = Command::new(craft)
        .args(["review", "start", "--no-recall", "--no-gate", "--cwd"])
        .arg(&code)
        .arg("--run-dir")
        .arg(&run)
        .output()
        .unwrap();
    assert!(started.status.success(), "{started:?}");
    // No gh anywhere: a refusal must come before any is looked for.
    let out = Command::new(craft)
        .args(["review", "comment", "--run"])
        .arg(&run)
        .env("PATH", "/nonexistent")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.starts_with("craft: the run in "), "{err}");
    assert!(err.contains("has not finished: resume it first"), "{err}");
    assert!(out.stdout.is_empty());
}
