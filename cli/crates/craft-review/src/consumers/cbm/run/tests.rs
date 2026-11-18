//! `bounded` returns within its limit whatever the program leaves behind, and refuses output it
//! cannot read whole.

use std::process::Command;
use std::time::{Duration, Instant};

use super::bounded;

fn sh(script: &str) -> Command {
    let mut c = Command::new("sh");
    c.args(["-c", script]);
    c
}

#[test]
fn a_program_that_leaves_a_child_holding_its_stdout_returns_within_the_limit() {
    let start = Instant::now();
    let got = bounded(sh("echo hi; sleep 5 &"), Duration::from_millis(500));
    assert!(
        start.elapsed() < Duration::from_millis(2000),
        "{:?}",
        start.elapsed()
    );
    let (ok, out, _) = got.unwrap();
    assert!(ok);
    assert_eq!(out.trim(), "hi");
}

#[test]
fn a_program_past_the_limit_is_killed_with_its_group() {
    let t = tempfile::tempdir().unwrap();
    let pid = t.path().join("pid");
    let script = format!("sleep 5 & echo $! > {}; wait", pid.display());
    let start = Instant::now();
    let got = bounded(sh(&script), Duration::from_millis(300));
    assert!(
        start.elapsed() < Duration::from_millis(2000),
        "{:?}",
        start.elapsed()
    );
    assert!(matches!(got, Err(super::CbmError::Timeout(_))), "{got:?}");
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
fn an_answer_past_a_pipe_buffer_is_read_whole() {
    let got = bounded(
        sh("head -c 200000 /dev/zero | tr '\\0' a"),
        Duration::from_secs(10),
    );
    assert_eq!(got.unwrap().1.len(), 200_000);
}

#[test]
fn a_stdout_over_the_cap_is_a_failed_answer() {
    let script = format!("head -c {} /dev/zero", super::CAP + 1);
    let got = bounded(sh(&script), Duration::from_secs(20));
    let err = got.unwrap_err().to_string();
    assert!(err.contains("stdout over"), "{err}");
}

#[test]
fn a_stdout_that_is_not_text_is_named_unreadable() {
    let got = bounded(sh("printf '\\377'"), Duration::from_secs(10));
    let err = got.unwrap_err().to_string();
    assert!(err.starts_with("stdout unreadable"), "{err}");
}

#[test]
fn the_last_line_is_the_last_non_empty_one_of_stderr_then_stdout() {
    assert_eq!(super::last_line("boom\n", "\n  \n"), "boom");
    assert_eq!(super::last_line("", "a\nb\n"), "b");
    assert_eq!(super::last_line("", ""), "no message");
}
