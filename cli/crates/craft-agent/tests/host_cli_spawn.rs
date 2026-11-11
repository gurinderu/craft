//! The codex and pi backends against stand-in CLIs: shell scripts that answer as the real ones
//! do, or fail, or answer nothing.

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use craft_agent::codex::Codex;
use craft_agent::pi::Pi;
use craft_agent::{AgentBackend, AgentError, AgentRequest};
use serde_json::json;

fn script(dir: &Path, name: &str, body: &str) -> std::io::Result<PathBuf> {
    let path = dir.join(name);
    common::write_executable(&path, &format!("#!/bin/sh\n{body}\n"))?;
    Ok(path)
}

fn request(cwd: &Path) -> AgentRequest {
    AgentRequest {
        label: "t".into(),
        prompt: "the prompt".into(),
        model: None,
        schema: Some(
            json!({"type": "object", "required": ["a"], "properties": {"a": {"type": "string"}, "b": {"type": "string"}}}),
        ),
        allowed_tools: Vec::new(),
        cwd: cwd.to_path_buf(),
    }
}

fn codex(command: PathBuf) -> Codex {
    Codex {
        command,
        timeout: Duration::from_secs(10),
        env: vec![("CRAFT_TEST_ROOT".into(), "/root".into())],
    }
}

/// A stand-in codex that keeps its stdin, argv, environment and strict schema, then writes its
/// answer to the `-o` file.
const CODEX_ANSWERS: &str = r#"cat > stdin.txt; echo "$@" > argv.txt; echo "$CRAFT_TEST_ROOT" > env.txt
while [ $# -gt 0 ]; do case "$1" in --output-schema) cp "$2" schema.txt; shift;; -o) out="$2"; shift;; esac; shift; done
printf '{"a":"x","b":null}' > "$out""#;

#[tokio::test]
async fn codex_reads_the_prompt_on_stdin_and_its_answer_from_its_own_file() {
    let dir = tempfile::tempdir().unwrap();
    let reply = codex(script(dir.path(), "codex", CODEX_ANSWERS).unwrap())
        .run(&request(dir.path()))
        .await
        .unwrap();
    assert_eq!(reply.structured, Some(json!({"a": "x"})));
    let read = |f: &str| std::fs::read_to_string(dir.path().join(f)).unwrap();
    assert_eq!(read("stdin.txt"), "the prompt");
    assert_eq!(read("env.txt").trim(), "/root");
    assert!(read("argv.txt").starts_with("exec --ephemeral -s read-only --output-schema "));
    let schema: serde_json::Value = serde_json::from_str(&read("schema.txt")).unwrap();
    assert_eq!(schema["required"], json!(["a", "b"]));
}

#[tokio::test]
async fn codex_failing_keeps_both_streams_and_a_clean_exit_with_no_file_is_no_answer() {
    let dir = tempfile::tempdir().unwrap();
    let failing = script(
        dir.path(),
        "codex",
        "echo out; echo 'Not logged in' >&2; exit 1",
    )
    .unwrap();
    let err = codex(failing).run(&request(dir.path())).await.unwrap_err();
    assert!(
        matches!(&err, AgentError::Quit { code: Some(1), stderr, stdout } if stderr == "Not logged in" && stdout == "out"),
        "{err:?}"
    );
    let silent = script(dir.path(), "codex2", "cat > /dev/null; echo hm >&2").unwrap();
    let err = codex(silent).run(&request(dir.path())).await.unwrap_err();
    assert!(
        matches!(&err, AgentError::NoAnswer { stderr, .. } if stderr == "hm"),
        "{err:?}"
    );
}

fn pi(command: PathBuf) -> Pi {
    Pi {
        command,
        timeout: Duration::from_secs(10),
        env: Vec::new(),
    }
}

#[tokio::test]
async fn pi_takes_the_prompt_as_its_last_word_and_the_answer_from_what_it_printed() {
    let dir = tempfile::tempdir().unwrap();
    let body = r#"for a in "$@"; do last="$a"; done; printf '%s' "$last" > prompt.txt
printf 'Done.\n```craft-answer\n{"a": "y"}\n```\n'"#;
    let reply = pi(script(dir.path(), "pi", body).unwrap())
        .run(&request(dir.path()))
        .await
        .unwrap();
    assert_eq!(reply.structured, Some(json!({"a": "y"})));
    assert_eq!(
        std::fs::read_to_string(dir.path().join("prompt.txt")).unwrap(),
        "the prompt"
    );
}

#[tokio::test]
async fn pi_printing_no_object_is_no_answer_and_a_failure_keeps_its_words() {
    let dir = tempfile::tempdir().unwrap();
    let err = pi(script(dir.path(), "pi", "echo 'all done'; echo last >&2").unwrap())
        .run(&request(dir.path()))
        .await
        .unwrap_err();
    assert!(
        matches!(&err, AgentError::NoAnswer { stderr, .. } if stderr == "last"),
        "{err:?}"
    );
    let err = pi(script(
        dir.path(),
        "pi2",
        "echo 'No API key found for x' >&2; exit 1",
    )
    .unwrap())
    .run(&request(dir.path()))
    .await
    .unwrap_err();
    assert!(
        matches!(&err, AgentError::Quit { stderr, .. } if stderr.starts_with("No API key found")),
        "{err:?}"
    );
}
