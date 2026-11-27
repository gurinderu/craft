//! A single JSON list on stdin starts a run; two stdin readers refuse before reading either.
use std::io::Write;
use std::process::Stdio;
use std::time::{Duration, Instant};

use super::start_command;

#[test]
fn each_single_stdin_list_starts_a_pending_run() {
    for flag in ["--prior-ledger", "--prior-decisions"] {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let run = home.join("run");
        let mut child = start_command(&["--report", "/r.md", flag, "-"], home, &run, home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(b"[]").unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(
            out.status.success(),
            "{flag}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let step: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(step["done"], false, "{flag}: {step}");
        assert!(
            !step["tasks"].as_array().unwrap().is_empty(),
            "{flag}: {step}"
        );
        assert!(run.join("state.json").is_file());
    }
}

#[test]
fn both_stdin_lists_refuse_while_the_empty_pipe_is_still_open() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path();
    let run = home.join("run");
    let mut child = start_command(
        &[
            "--report",
            "/r.md",
            "--prior-ledger",
            "-",
            "--prior-decisions",
            "-",
        ],
        home,
        &run,
        home,
    )
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .unwrap();
    let input = child.stdin.take().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let exited = child.try_wait().unwrap().is_some();
    if !exited {
        child.kill().unwrap();
    }
    drop(input);
    let out = child.wait_with_output().unwrap();
    assert!(exited, "the refusal must not wait for stdin");
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("cannot both be read from stdin"));
    assert!(out.stdout.is_empty());
    assert!(!run.exists());
}
