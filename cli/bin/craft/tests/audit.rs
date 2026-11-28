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

use serde_json::{Value, json};

#[path = "audit/answers.rs"]
mod answers;
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

fn clean(step: &Value) {
    for t in step["tasks"].as_array().unwrap() {
        let file = t["answerFile"].as_str().unwrap();
        std::fs::write(file, json!({"lens": "l", "findings": []}).to_string()).unwrap();
    }
}

#[test]
fn a_pass_the_budget_cuts_short_files_its_record_and_a_resume_reads_only_what_it_left() {
    let s = scratch(&["src/lib.rs", "tool.py"]);
    let first = start(&s, &["--lens-agents", "1", "--batch-bytes", "4"]);
    assert_eq!(ids(&first), ["lens-1-rust-correctness-0"], "{first}");
    let state: Value =
        serde_json::from_str(&std::fs::read_to_string(s.run.join("state.json")).unwrap()).unwrap();
    assert_eq!(state["args"]["craftVersion"], "9.9.9");
    assert_eq!(state["args"]["record"]["session"], "s-9");
    assert_eq!(state["args"]["batchBytes"], 4);
    clean(&first);
    let done = submit(&s, &[]);
    assert_eq!(done["verdict"], "INCOMPLETE", "{done}");
    let unread = std::fs::read_to_string(done["unread"]["file"].as_str().unwrap()).unwrap();
    assert_eq!(unread, "src/lib.rs\ntool.py\n");
    assert_eq!(done["filing"]["record"], "filed", "{done}");
    let index = std::fs::read_to_string(s.home.join(".craft/runs/index.jsonl")).unwrap();
    assert!(index.contains("\"name\":\"audit\""), "{index}");
    let report = std::fs::read_to_string(done["report"].as_str().unwrap()).unwrap();
    assert!(report.contains("## Verdict\n\n**INCOMPLETE**"), "{report}");
    let second = submit(&s, &["--resume"]);
    assert_eq!(second["pass"], 2);
    assert_eq!(ids(&second), ["lens-2-rust-security-0"], "{second}");
    let run = s.run.display().to_string();
    let st = ok(&craft(&s, &["audit", "status", "--run", &run]));
    assert_eq!(
        (st["phase"].clone(), st["pass"].clone()),
        (json!("lens"), json!(2))
    );
}
