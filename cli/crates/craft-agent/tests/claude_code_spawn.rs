//! The claude-code backend against a stand-in `claude`: a shell script that answers with the real
//! reply fixture, or fails, or hangs.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use craft_agent::anthropic_api::AnthropicApi;
use craft_agent::claude_code::ClaudeCode;
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
