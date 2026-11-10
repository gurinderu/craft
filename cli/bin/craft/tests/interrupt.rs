//! A stopping signal to craft's group during a run, end to end: the built `craft` against a
//! stand-in `claude` that starts a grandchild. A terminal's Ctrl-C (SIGINT) and `Ctrl-\` (SIGQUIT),
//! `kill %1` or a supervisor (SIGTERM) and a closed terminal (SIGHUP) all signal craft's whole
//! group; the agent runs in a group of its own, so only craft hears it, stops the run with 128 +
//! the signal's number, and takes the agent and its grandchild down with it before it exits — even
//! when they ignore SIGTERM and only the SIGKILL after the grace ends them.
#![cfg(target_os = "linux")]

mod common;

use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

/// Starts a grandchild and records both pids, the child's last; `prelude` runs first.
fn stand_in(dir: &Path, prelude: &str) -> std::io::Result<PathBuf> {
    let path = dir.join("claude");
    let body = format!(
        "#!/bin/sh\n{prelude}\nsleep 300 &\necho $! > grandchild\necho $$ > pid.tmp; mv pid.tmp pid\nwait\n"
    );
    common::write_executable(&path, &body)?;
    Ok(path)
}

fn pid_in(dir: &Path, name: &str) -> Option<u32> {
    std::fs::read_to_string(dir.join(name))
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// Gone, or a zombie (killed, not yet reaped).
fn gone(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat")).map_or(true, |s| {
        s.rsplit(')')
            .next()
            .is_some_and(|rest| rest.trim_start().starts_with('Z'))
    })
}

fn wait_until(what: &str, within: Duration, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + within;
    while !done() {
        assert!(Instant::now() < deadline, "{what}: not within {within:?}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Runs craft as the leader of a group, as a shell's job is; once the agent is up, sends `signal`
/// to the whole group, as a terminal or `kill %1` does, and returns once craft has exited, with
/// how long that took after the signal.
fn signal_craft(
    signal: &str,
    prelude: &str,
) -> std::io::Result<(tempfile::TempDir, Output, Duration)> {
    let dir = tempfile::tempdir()?;
    let claude = stand_in(dir.path(), prelude)?;
    let mut craft = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(["review", "probe", "--plain", "--cwd"])
        .arg(dir.path())
        .arg("--claude")
        .arg(&claude)
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let pid_file = dir.path().join("pid");
    wait_until("the agent started", Duration::from_secs(10), || {
        pid_file.exists()
    });
    let signalled = Instant::now();
    let sent = Command::new("kill")
        .args([&format!("-{signal}"), "--", &format!("-{}", craft.id())])
        .status()?;
    if !sent.success() {
        return Err(std::io::Error::other(format!("kill -{signal}: {sent}")));
    }
    wait_until("craft exited", Duration::from_secs(10), || {
        craft.try_wait().is_ok_and(|s| s.is_some())
    });
    let took = signalled.elapsed();
    Ok((dir, craft.wait_with_output()?, took))
}

/// craft exited with `code`, and the agent and its grandchild were gone (or zombies) by then.
fn assert_stopped(dir: &Path, out: &Output, code: i32) {
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(code), "{stderr}");
    assert!(stderr.contains("craft: stopped"), "{stderr}");
    // Well under the two-second grace: without craft waiting it out, a SIGTERM-ignoring group
    // would never see its SIGKILL. The margin is only for reaping by init.
    for name in ["pid", "grandchild"] {
        let pid = pid_in(dir, name);
        assert!(pid.is_some(), "no {name} pid");
        if let Some(pid) = pid {
            wait_until(
                &format!("{name} {pid} gone"),
                Duration::from_millis(500),
                || gone(pid),
            );
        }
    }
}

/// An ignored signal stays ignored across fork and exec, so the grandchild ignores it too.
const IGNORES_SIGTERM: &str = "trap '' TERM";

#[test]
fn ctrl_c_in_the_terminal_stops_the_run_as_interrupted() {
    let (dir, out, took) = signal_craft("INT", "").unwrap();
    assert_stopped(dir.path(), &out, 130);
    // An agent that obeys SIGTERM is not waited on for the two-second grace.
    assert!(took < Duration::from_secs(1), "took {took:?}");
}

#[test]
fn ctrl_c_outlasts_an_agent_that_ignores_sigterm() {
    let (dir, out, _took) = signal_craft("INT", IGNORES_SIGTERM).unwrap();
    assert_stopped(dir.path(), &out, 130);
}

#[test]
fn sigterm_stops_the_run_and_outlasts_an_agent_that_ignores_it() {
    let (dir, out, _took) = signal_craft("TERM", IGNORES_SIGTERM).unwrap();
    assert_stopped(dir.path(), &out, 143);
}

#[test]
fn sighup_stops_the_run() {
    let (dir, out, _took) = signal_craft("HUP", "").unwrap();
    assert_stopped(dir.path(), &out, 129);
}

#[test]
fn ctrl_backslash_stops_the_run_as_quit() {
    let (dir, out, _took) = signal_craft("QUIT", "").unwrap();
    assert_stopped(dir.path(), &out, 131);
}
