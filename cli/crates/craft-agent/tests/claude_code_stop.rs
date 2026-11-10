//! A stopped or timed-out claude-code run takes its subprocess's process group with it: a
//! stand-in `claude` starts a grandchild in that group, and both must be gone soon after.
#![cfg(target_os = "linux")]

mod common;

use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use craft_agent::claude_code::ClaudeCode;
use craft_agent::runner::{Batch, run_until};
use craft_agent::{AgentBackend, AgentError, AgentRequest};

/// Starts a grandchild, records both pids (the child's last, so its file means both are there),
/// and waits on the grandchild. `prelude` runs first.
fn stand_in(dir: &Path, prelude: &str) -> std::io::Result<PathBuf> {
    let path = dir.join("claude");
    let body = format!(
        "#!/bin/sh\n{prelude}\nsleep 300 &\necho $! > grandchild\necho $$ > pid.tmp; mv pid.tmp pid\nwait\n"
    );
    common::write_executable(&path, &body)?;
    Ok(path)
}

fn request(cwd: &Path) -> AgentRequest {
    AgentRequest {
        label: "probe".into(),
        prompt: "the prompt".into(),
        model: None,
        schema: None,
        allowed_tools: Vec::new(),
        cwd: cwd.to_path_buf(),
    }
}

fn backend(command: PathBuf, timeout: Duration) -> ClaudeCode {
    ClaudeCode {
        command,
        timeout,
        ..ClaudeCode::default()
    }
}

async fn appeared(file: &Path) {
    while !file.exists() {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn pid_in(dir: &Path, name: &str) -> Option<u32> {
    std::fs::read_to_string(dir.join(name))
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// Waits until `pid` is gone or a zombie (killed, not yet reaped), failing after `within`.
async fn assert_gone(pid: u32, within: Duration) {
    let stat = PathBuf::from(format!("/proc/{pid}/stat"));
    let deadline = Instant::now() + within;
    loop {
        let Ok(s) = std::fs::read_to_string(&stat) else {
            return;
        };
        if s.rsplit(')')
            .next()
            .is_some_and(|rest| rest.trim_start().starts_with('Z'))
        {
            return;
        }
        assert!(Instant::now() < deadline, "{pid} still running: {s}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Runs the stand-in until the child has written its pid, then stops the batch.
async fn stop_once_started(prelude: &str) -> std::io::Result<(tempfile::TempDir, Duration)> {
    let dir = tempfile::tempdir()?;
    let cmd = stand_in(dir.path(), prelude)?;
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let began = Instant::now();
    let batch = run_until(
        Arc::new(backend(cmd, Duration::from_secs(60))),
        vec![request(dir.path())],
        NonZeroUsize::MIN,
        tx,
        appeared(&dir.path().join("pid")),
    )
    .await;
    assert!(
        matches!(batch, Batch::Stopped(ref slots) if matches!(slots.as_slice(), [None])),
        "{batch:?}"
    );
    Ok((dir, began.elapsed()))
}

#[tokio::test]
async fn a_stop_ends_the_agent_and_what_it_started() {
    let (dir, took) = stop_once_started("").await.unwrap();
    assert!(took < Duration::from_secs(10), "{took:?}");
    for name in ["pid", "grandchild"] {
        assert_gone(pid_in(dir.path(), name).unwrap(), Duration::from_secs(1)).await;
    }
}

#[tokio::test]
async fn a_group_that_ignores_sigterm_is_killed_after_the_grace() {
    // An ignored signal stays ignored across fork and exec, so the grandchild ignores it too.
    let (dir, _took) = stop_once_started("trap '' TERM").await.unwrap();
    for name in ["pid", "grandchild"] {
        assert_gone(pid_in(dir.path(), name).unwrap(), Duration::from_secs(5)).await;
    }
}

#[tokio::test]
async fn a_timeout_ends_the_agent_and_what_it_started() {
    let dir = tempfile::tempdir().unwrap();
    let cmd = stand_in(dir.path(), "").unwrap();
    let err = backend(cmd, Duration::from_millis(500))
        .run(&request(dir.path()))
        .await
        .unwrap_err();
    assert!(matches!(err, AgentError::TimedOut(_)), "{err}");
    for name in ["pid", "grandchild"] {
        assert_gone(pid_in(dir.path(), name).unwrap(), Duration::from_secs(1)).await;
    }
}
