//! `--prior-decisions -` held open: a stop signal ends the read before any task, and a list that
//! was closed still reaches the run (realm @nick/craft, node #737).

use std::io::Write;
use std::os::unix::process::ExitStatusExt;
use std::process::Stdio;
use std::time::{Duration, Instant};

use super::HANGING_CODEX;
use super::common;
use super::fixture::{Bench, signal, wait_until};

#[test]
fn sigterm_interrupts_prior_decisions_held_open_on_stdin() {
    interrupted("-TERM", 15);
}

#[test]
fn sigint_interrupts_prior_decisions_held_open_on_stdin() {
    interrupted("-INT", 2);
}

fn interrupted(sig: &str, number: i32) {
    let bench = Bench::new();
    common::write_executable(&bench.bin.join("codex"), HANGING_CODEX).unwrap();
    let mut craft = bench
        .command(false)
        .args(["--prior-decisions", "-"])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    craft.stdin.as_mut().unwrap().write_all(b"[").unwrap();
    let wchan = format!("/proc/{}/wchan", craft.id());
    wait_until("craft reading stdin", Duration::from_secs(10), || {
        std::fs::read_to_string(&wchan).is_ok_and(|s| s.trim() == "pipe_read")
    });
    signal(&craft, sig);
    let bound = Instant::now() + Duration::from_secs(3);
    while craft.try_wait().unwrap().is_none() && Instant::now() < bound {
        std::thread::sleep(Duration::from_millis(20));
    }
    let exited = craft.try_wait().unwrap().is_some();
    if !exited {
        craft.kill().unwrap();
    }
    // The input pipe stays open until the signal's effect is seen.
    let out = craft.wait_with_output().unwrap();
    assert!(exited, "still reading stdin after {sig}: {out:?}");
    assert_eq!(out.status.signal(), Some(number), "{out:?}");
    assert!(!bench.bin.join("pid").exists(), "no task may run");
    assert!(!bench.home.join(".craft/runs").exists(), "nothing filed");
}

#[test]
fn a_list_closed_on_stdin_still_reaches_the_run() {
    let bench = Bench::new();
    common::write_executable(&bench.bin.join("codex"), HANGING_CODEX).unwrap();
    let mut craft = bench
        .command(false)
        .args(["--prior-decisions", "-"])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = craft.stdin.take().unwrap();
    input.write_all(br#"{"read-ahead":"marker"}"#).unwrap();
    drop(input);
    wait_until("a task started", Duration::from_secs(30), || {
        bench.bin.join("pid").exists()
    });
    signal(&craft, "-TERM");
    let out = craft.wait_with_output().unwrap();
    let state = state_of(&bench);
    assert!(state.contains("read-ahead"), "{state}\n{out:?}");
}

/// The one run's state under the bench's home.
fn state_of(bench: &Bench) -> String {
    let runs = bench.home.join(".craft/runs/cli");
    let dir = std::fs::read_dir(&runs).unwrap().next().unwrap().unwrap();
    std::fs::read_to_string(dir.path().join("state.json")).unwrap()
}
