//! `craft triage start` as a host runs it: the run opened with its first tasks, and `--record`
//! kept in the run's arguments — the craft version its record is filed under and the session it
//! names — so the run files its record once it ends (realm @nick/craft, node #616).
#![expect(
    clippy::unwrap_used,
    reason = "fixture setup and JSON assertions fail loudly"
)]

use std::path::Path;
use std::process::Command;

use serde_json::Value;

fn start(home: &Path, repo: &Path, run: &Path, extra: &[&str]) -> Value {
    let report = repo.join("report.md");
    std::fs::write(&report, "- [High] src/a.rs:1 — a finding\n").unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(["triage", "start", "--cwd"])
        .arg(repo)
        .arg("--run-dir")
        .arg(run)
        .arg("--report")
        .arg(&report)
        .args(extra)
        .env("HOME", home)
        .env("CLAUDE_CODE_SESSION_ID", "s-7")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}

fn args_of(run: &Path) -> Value {
    let state: Value =
        serde_json::from_str(&std::fs::read_to_string(run.join("state.json")).unwrap()).unwrap();
    state.get("args").cloned().unwrap()
}

#[test]
fn a_triage_started_recording_keeps_its_version_and_session_and_hands_out_its_gatherer() {
    let d = tempfile::tempdir().unwrap();
    let (home, repo, run) = (
        d.path().join("home"),
        d.path().join("repo"),
        d.path().join("run"),
    );
    std::fs::create_dir_all(&repo).unwrap();
    let step = start(&home, &repo, &run, &["--record", "9.9.9"]);
    let tasks = step["tasks"].as_array().unwrap();
    assert!(!tasks.is_empty(), "{step}");
    let args = args_of(&run);
    assert_eq!(args["craftVersion"], "9.9.9");
    assert_eq!(args["record"]["session"], "s-7");
}

#[test]
fn a_triage_started_without_record_files_nothing_under_this_binarys_version() {
    let d = tempfile::tempdir().unwrap();
    let (home, repo, run) = (
        d.path().join("home"),
        d.path().join("repo"),
        d.path().join("run"),
    );
    std::fs::create_dir_all(&repo).unwrap();
    start(&home, &repo, &run, &[]);
    let args = args_of(&run);
    assert_eq!(args["craftVersion"], env!("CARGO_PKG_VERSION"));
    assert!(args.get("record").is_none(), "{args}");
}
