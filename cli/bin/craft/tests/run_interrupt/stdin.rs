//! `--prior-decisions -` held open: a stop signal ends the read before any task, and a list that
//! was closed still reaches the run — `review run`'s, read ahead, and `review start`'s, read in
//! the start (realm @nick/craft, node #737).

use std::io::Write;
use std::os::unix::process::ExitStatusExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::HANGING_CODEX;
use super::common;
use super::fixture::{Bench, all_gone, signal, wait_until};

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
        .command("codex", false)
        .args(["--prior-decisions", "-"])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    craft.stdin.as_mut().unwrap().write_all(b"[").unwrap();
    let bound = Instant::now() + Duration::from_secs(10);
    let reading = loop {
        if reading_stdin(craft.id()) {
            break true;
        }
        if Instant::now() >= bound {
            break false;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    if !reading {
        craft.kill().unwrap();
    }
    assert!(
        reading,
        "never blocked reading stdin: {:?}",
        craft.wait_with_output()
    );
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

/// `read(2)` on `x86_64` and `aarch64`, the number `/proc/<pid>/syscall` starts with.
const READ: &str = if cfg!(target_arch = "aarch64") {
    "63"
} else {
    "0"
};

/// Whether `pid` is blocked reading its stdin: the kernel's wait channel where it names one (a
/// runner's kernel may print `0` there), else the system call it sits in, read from fd 0.
fn reading_stdin(pid: u32) -> bool {
    let proc = |f: &str| std::fs::read_to_string(format!("/proc/{pid}/{f}")).unwrap_or_default();
    proc("wchan").trim() == "pipe_read"
        || proc("syscall").split_whitespace().take(2).eq([READ, "0x0"])
}

#[test]
fn a_list_closed_on_stdin_still_reaches_the_run() {
    let bench = Bench::new();
    common::write_executable(&bench.bin.join("codex"), HANGING_CODEX).unwrap();
    let mut craft = bench
        .command("codex", false)
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
    all_gone(&bench.bin, &["pid", "grandchild"]);
    let runs = bench.home.join(".craft/runs/cli");
    let dir = std::fs::read_dir(&runs).unwrap().next().unwrap().unwrap();
    let state = std::fs::read_to_string(dir.path().join("state.json")).unwrap();
    assert!(state.contains("read-ahead"), "{state}\n{out:?}");
}

#[test]
fn review_start_reads_a_list_on_stdin_itself() {
    let bench = Bench::new();
    let run = bench.home.join("run");
    let mut craft = Command::new(env!("CARGO_BIN_EXE_craft"))
        .env("CRAFT_CODE_GRAPH", "")
        .env("HOME", &bench.home)
        .args([
            "review",
            "start",
            "--no-recall",
            "--no-gate",
            "--depth",
            "light",
        ])
        .args(["--prior-decisions", "-", "--cwd"])
        .arg(&bench.repo)
        .arg("--run-dir")
        .arg(&run)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = craft.stdin.take().unwrap();
    input.write_all(br#"{"read-in-start":"marker"}"#).unwrap();
    drop(input);
    let out = craft.wait_with_output().unwrap();
    assert!(out.status.success(), "{out:?}");
    let state = std::fs::read_to_string(run.join("state.json")).unwrap();
    assert!(state.contains("read-in-start"), "{state}");
}
