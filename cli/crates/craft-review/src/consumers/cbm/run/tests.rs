//! `bounded` returns within its limit whatever the program leaves behind, stops with the run, and
//! refuses output it cannot read whole.

use std::process::Command;
use std::time::{Duration, Instant};

use super::{CbmError, bounded};
use crate::cancel::Cancel;

fn sh(script: &str) -> Command {
    let mut c = Command::new("sh");
    c.args(["-c", script]);
    c
}

fn run(script: &str, limit: Duration) -> Result<(bool, String, String), CbmError> {
    bounded(sh(script), limit, &Cancel::default())
}

fn within(start: Instant, ms: u64) {
    assert!(
        start.elapsed() < Duration::from_millis(ms),
        "{:?}",
        start.elapsed()
    );
}

#[test]
fn a_program_that_leaves_a_child_holding_its_stdout_returns_at_once() {
    let start = Instant::now();
    let got = run("echo hi; sleep 5 &", Duration::from_secs(4));
    within(start, 2000);
    let (ok, out, _) = got.unwrap();
    assert!(ok);
    assert_eq!(out.trim(), "hi");
}

#[test]
fn a_child_that_left_the_group_and_holds_stdout_does_not_hold_the_answer() {
    // `setsid` puts the sleeper in a session of its own, out of the group's kill.
    let start = Instant::now();
    let got = run("echo hi; setsid sh -c 'sleep 5' &", Duration::from_secs(4));
    within(start, 2000);
    assert_eq!(got.unwrap().1.trim(), "hi");
}

#[test]
fn a_program_past_the_limit_is_killed_with_its_group() {
    let t = tempfile::tempdir().unwrap();
    let pid = t.path().join("pid");
    let script = format!("sleep 5 & echo $! > {}; wait", pid.display());
    let start = Instant::now();
    let got = run(&script, Duration::from_millis(300));
    within(start, 2000);
    assert!(matches!(got, Err(CbmError::Timeout(_))), "{got:?}");
    let pid = std::fs::read_to_string(&pid).unwrap();
    let proc = std::path::Path::new("/proc").join(pid.trim());
    let gone = (0..50).any(|_| {
        std::thread::sleep(Duration::from_millis(20));
        !proc.exists()
    });
    assert!(
        gone,
        "the program's own child outlived it: {}",
        proc.display()
    );
}

#[test]
fn a_stop_kills_the_program_and_says_so() {
    let cancel = Cancel::default();
    let stopper = cancel.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        stopper.cancel();
    });
    let start = Instant::now();
    let got = bounded(sh("sleep 5"), Duration::from_secs(10), &cancel);
    within(start, 2000);
    assert_eq!(got, Err(CbmError::Stopped));
}

#[test]
fn an_answer_past_a_pipe_buffer_is_read_whole() {
    let got = run(
        "head -c 200000 /dev/zero | tr '\\0' a",
        Duration::from_secs(10),
    );
    assert_eq!(got.unwrap().1.len(), 200_000);
}

#[test]
fn a_stdout_over_the_cap_is_a_failed_answer() {
    let script = format!("head -c {} /dev/zero", super::CAP + 1);
    let err = run(&script, Duration::from_secs(20))
        .unwrap_err()
        .to_string();
    assert!(err.contains("stdout unreadable: over"), "{err}");
}

#[test]
fn a_stdout_that_is_not_text_is_named_unreadable() {
    let err = run("printf '\\377'", Duration::from_secs(10))
        .unwrap_err()
        .to_string();
    assert!(err.starts_with("stdout unreadable"), "{err}");
}

#[test]
fn the_last_line_is_the_last_non_empty_one_of_stderr_then_stdout() {
    assert_eq!(super::last_line("boom\n", "\n  \n"), "boom");
    assert_eq!(super::last_line("", "a\nb\n"), "b");
    assert_eq!(super::last_line("", ""), "no message");
}
