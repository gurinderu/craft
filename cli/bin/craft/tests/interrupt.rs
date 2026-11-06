//! A terminal's Ctrl-C during a run, end to end: the built `craft` against a stand-in `claude`
//! that starts a grandchild. The terminal signals its whole foreground group; the agent runs in a
//! group of its own, so only craft hears it, stops the run as interrupted (130), and takes the
//! agent and what it started down with it.
#![cfg(target_os = "linux")]

use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn stand_in(dir: &Path) -> std::io::Result<PathBuf> {
    let path = dir.join("claude");
    let body =
        "#!/bin/sh\nsleep 300 &\necho $! > grandchild\necho $$ > pid.tmp; mv pid.tmp pid\nwait\n";
    std::fs::write(&path, body)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
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

#[test]
fn ctrl_c_in_the_terminal_stops_the_run_as_interrupted() {
    let dir = tempfile::tempdir().unwrap();
    let claude = stand_in(dir.path()).unwrap();
    // craft leads a group, as a shell's foreground job does.
    let mut craft = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(["review", "--plain", "--cwd"])
        .arg(dir.path())
        .arg("--claude")
        .arg(&claude)
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let pid_file = dir.path().join("pid");
    wait_until("the agent started", Duration::from_secs(10), || {
        pid_file.exists()
    });
    // What the terminal does on Ctrl-C: SIGINT to every process of the foreground group.
    let status = Command::new("kill")
        .args(["-INT", "--", &format!("-{}", craft.id())])
        .status()
        .unwrap();
    assert!(status.success());
    wait_until("craft exited", Duration::from_secs(10), || {
        craft.try_wait().unwrap().is_some()
    });
    let out = craft.wait_with_output().unwrap();
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(130), "{stderr}");
    assert!(stderr.contains("craft: stopped"), "{stderr}");
    for name in ["pid", "grandchild"] {
        let pid = pid_in(dir.path(), name).unwrap();
        wait_until(
            &format!("{name} {pid} gone"),
            Duration::from_secs(5),
            || gone(pid),
        );
    }
}
