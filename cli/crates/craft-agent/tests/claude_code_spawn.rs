//! The claude-code backend against a stand-in `claude`: a shell script that answers with the real
//! reply fixture, or fails, or hangs, or is stopped.

use std::num::NonZeroUsize;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use craft_agent::anthropic_api::AnthropicApi;
use craft_agent::claude_code::ClaudeCode;
use craft_agent::runner::{Batch, run_until};
use craft_agent::{AgentBackend, AgentError, AgentRequest};

/// Held by each test for its whole run: a script written while another test forks keeps a write
/// handle open in that child until it execs, and running the script then fails with ETXTBSY.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/reply-success.json"
);

fn script(dir: &Path, body: &str) -> std::io::Result<PathBuf> {
    let path = dir.join("claude");
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n"))?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
    Ok(path)
}

fn request(cwd: &Path) -> AgentRequest {
    AgentRequest {
        label: "probe".into(),
        prompt: "the prompt".into(),
        model: None,
        schema: Some(serde_json::json!({"type": "object"})),
        allowed_tools: vec!["Read".into()],
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

#[tokio::test]
async fn the_prompt_goes_on_stdin_and_the_reply_is_read() {
    let _serial = SERIAL.lock().await;
    let dir = tempfile::tempdir().unwrap();
    // The stand-in keeps what it was given, so the test sees the prompt and the argv.
    let cmd = script(
        dir.path(),
        &format!("cat > stdin.txt; echo \"$@\" > argv.txt; cat '{FIXTURE}'"),
    )
    .unwrap();
    let reply = backend(cmd, Duration::from_secs(10))
        .run(&request(dir.path()))
        .await
        .unwrap();
    assert_eq!(
        reply.structured,
        Some(serde_json::json!({"ok": true, "note": "Done."}))
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("stdin.txt")).unwrap(),
        "the prompt"
    );
    let argv = std::fs::read_to_string(dir.path().join("argv.txt")).unwrap();
    assert!(argv.starts_with("-p --output-format json"), "{argv}");
    assert!(argv.trim_end().ends_with("--allowedTools Read"), "{argv}");
}

#[tokio::test]
async fn a_non_zero_exit_carries_the_code_and_stderr() {
    let _serial = SERIAL.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let cmd = script(dir.path(), "cat >/dev/null; echo boom >&2; exit 3").unwrap();
    let err = backend(cmd, Duration::from_secs(10))
        .run(&request(dir.path()))
        .await
        .unwrap_err();
    assert!(
        matches!(err, AgentError::Exit { code: Some(3), ref stderr } if stderr == "boom"),
        "{err}"
    );
}

#[tokio::test]
async fn a_child_that_exits_unread_still_reports_its_exit_and_stderr() {
    let _serial = SERIAL.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let cmd = script(dir.path(), "echo nope >&2; exit 4").unwrap();
    // Far past a pipe's buffer, so the write meets the closed pipe.
    let big = AgentRequest {
        prompt: "x".repeat(4 << 20),
        ..request(dir.path())
    };
    let err = backend(cmd, Duration::from_secs(10))
        .run(&big)
        .await
        .unwrap_err();
    assert!(
        matches!(err, AgentError::Exit { code: Some(4), ref stderr } if stderr == "nope"),
        "{err}"
    );
}

#[tokio::test]
async fn a_stop_kills_the_running_agent_and_returns_promptly() {
    let _serial = SERIAL.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pid");
    let cmd = script(
        dir.path(),
        "echo $$ > pid.tmp; mv pid.tmp pid; exec sleep 30",
    )
    .unwrap();
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let stop = {
        let pid_file = pid_file.clone();
        async move {
            while !pid_file.exists() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    };
    let began = Instant::now();
    let batch = run_until(
        Arc::new(backend(cmd, Duration::from_secs(60))),
        vec![request(dir.path())],
        NonZeroUsize::MIN,
        tx,
        stop,
    )
    .await;
    assert!(
        began.elapsed() < Duration::from_secs(10),
        "{:?}",
        began.elapsed()
    );
    assert!(
        matches!(batch, Batch::Stopped(ref slots) if slots.len() == 1 && slots[0].is_none()),
        "{batch:?}"
    );
    let pid = std::fs::read_to_string(&pid_file).unwrap();
    let stat = PathBuf::from(format!("/proc/{}/stat", pid.trim()));
    // Killed: gone, or a zombie until tokio reaps it.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match std::fs::read_to_string(&stat) {
            Err(_) => break,
            Ok(s)
                if s.rsplit(')')
                    .next()
                    .unwrap_or("")
                    .trim_start()
                    .starts_with('Z') =>
            {
                break;
            }
            Ok(s) => {
                assert!(Instant::now() < deadline, "still running: {s}");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    }
}

#[tokio::test]
async fn a_run_past_the_timeout_is_killed() {
    let _serial = SERIAL.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let cmd = script(dir.path(), "exec sleep 30").unwrap();
    let err = backend(cmd, Duration::from_millis(200))
        .run(&request(dir.path()))
        .await
        .unwrap_err();
    assert!(matches!(err, AgentError::TimedOut(_)), "{err}");
}

#[tokio::test]
async fn a_missing_command_is_a_spawn_error() {
    let _serial = SERIAL.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let err = backend(dir.path().join("absent"), Duration::from_secs(1))
        .run(&request(dir.path()))
        .await
        .unwrap_err();
    assert!(matches!(err, AgentError::Spawn { .. }), "{err}");
}

#[tokio::test]
async fn the_api_backend_is_not_there_yet() {
    let err = AnthropicApi
        .run(&request(Path::new(".")))
        .await
        .unwrap_err();
    assert!(
        matches!(
            err,
            AgentError::NotYet {
                backend: "anthropic-api"
            }
        ),
        "{err}"
    );
}
