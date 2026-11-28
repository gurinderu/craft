//! `craft audit start | submit | status` as a host runs them, over a scratch repository with the
//! run store under an isolated HOME: the lens agents a pass buys, the answers handed in by file or
//! by `--answers`, the finished pass's report and its record landed in the store, a resume over
//! what was left unread, and the arguments refused with the exit of a refused argument.
#![expect(
    clippy::unwrap_used,
    reason = "fixture setup and JSON assertions fail loudly"
)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::Value;

#[path = "audit/answers.rs"]
mod answers;
#[path = "audit/pass.rs"]
mod pass;
#[path = "audit/paths.rs"]
mod paths;
#[path = "audit/refused.rs"]
mod refused;

pub(crate) struct Scratch {
    _dir: tempfile::TempDir,
    pub(crate) home: PathBuf,
    pub(crate) repo: PathBuf,
    pub(crate) run: PathBuf,
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

pub(crate) fn scratch(files: &[&str]) -> Scratch {
    let d = tempfile::tempdir().unwrap();
    let (home, repo, run) = (
        d.path().join("home"),
        d.path().join("repo"),
        d.path().join("run"),
    );
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    for f in files {
        let at = repo.join(f);
        std::fs::create_dir_all(at.parent().unwrap()).unwrap();
        std::fs::write(at, "x = 1\n").unwrap();
    }
    git(&repo, &["add", "-A"]);
    Scratch {
        _dir: d,
        home,
        repo,
        run,
    }
}

pub(crate) fn craft(s: &Scratch, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(args)
        .env("HOME", &s.home)
        .env("CLAUDE_CODE_SESSION_ID", "s-9")
        .output()
        .unwrap()
}

pub(crate) fn ok(out: &Output) -> Value {
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}

pub(crate) fn start(s: &Scratch, extra: &[&str]) -> Value {
    let (repo, run) = (s.repo.display().to_string(), s.run.display().to_string());
    let mut args = vec![
        "audit",
        "start",
        "--cwd",
        &repo,
        "--run-dir",
        &run,
        "--record",
        "9.9.9",
    ];
    args.extend_from_slice(extra);
    ok(&craft(s, &args))
}

pub(crate) fn submit(s: &Scratch, extra: &[&str]) -> Value {
    let run = s.run.display().to_string();
    let mut args = vec!["audit", "submit", "--run", &run];
    args.extend_from_slice(extra);
    ok(&craft(s, &args))
}

pub(crate) fn ids(step: &Value) -> Vec<String> {
    step["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].as_str().unwrap().to_owned())
        .collect()
}
