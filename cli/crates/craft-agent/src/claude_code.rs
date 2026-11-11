//! The `claude-code` backend: each run is one `claude -p` subprocess, its prompt on stdin, its
//! answer the single JSON object `--output-format json` prints (see [`crate::reply`]).
//!
//! The CLI's flags and its reply are an external surface, pinned in (realm @nick/craft, node #449).
//!
//! What the subprocess is meant to read: the project's settings, CLAUDE.md/AGENTS.md and skills,
//! and craft's own skills and agents (`--plugin-dir`). `--setting-sources project,local` is meant
//! to keep the user-level settings and instructions under `~/.claude` out while keeping the OAuth
//! login that `--bare` would drop — seen only in a probe, by the model's own report of what it had
//! loaded, not verified.

use std::path::PathBuf;
use std::time::Duration;

use crate::{AgentBackend, AgentError, AgentReply, AgentRequest, reply, subprocess};

/// Runs agents through the `claude` CLI.
#[derive(Debug, Clone)]
pub struct ClaudeCode {
    /// The CLI to run, `claude` by default.
    pub command: PathBuf,
    /// Plugins every agent loads: craft's own root first, then any others.
    pub plugin_dirs: Vec<PathBuf>,
    /// A run that takes longer is killed.
    pub timeout: Duration,
}

impl Default for ClaudeCode {
    fn default() -> Self {
        Self {
            command: PathBuf::from("claude"),
            plugin_dirs: Vec::new(),
            timeout: Duration::from_secs(30 * 60),
        }
    }
}

impl ClaudeCode {
    /// The argv for one run; the prompt goes on stdin.
    #[must_use]
    pub fn argv(&self, request: &AgentRequest) -> Vec<String> {
        let mut argv: Vec<String> = [
            "-p",
            "--output-format",
            "json",
            "--permission-prompts",
            "none",
            "--setting-sources",
            "project,local",
        ]
        .map(String::from)
        .into();
        for dir in &self.plugin_dirs {
            argv.push("--plugin-dir".into());
            argv.push(dir.display().to_string());
        }
        if let Some(model) = &request.model {
            argv.push("--model".into());
            argv.push(model.clone());
        }
        if let Some(schema) = &request.schema {
            argv.push("--json-schema".into());
            argv.push(schema.to_string());
        }
        // Variadic on the CLI: kept last, so it swallows no other option.
        if !request.allowed_tools.is_empty() {
            argv.push("--allowedTools".into());
            argv.extend(request.allowed_tools.iter().cloned());
        }
        argv
    }
}

impl AgentBackend for ClaudeCode {
    async fn run(&self, request: &AgentRequest) -> Result<AgentReply, AgentError> {
        let argv = self.argv(request);
        let spawn = subprocess::Spawn {
            program: &self.command,
            args: &argv,
            cwd: &request.cwd,
            env: &[],
            stdin: request.prompt.as_bytes(),
        };
        let output = tokio::time::timeout(self.timeout, subprocess::output(spawn))
            .await
            .map_err(|_elapsed| AgentError::TimedOut(self.timeout))??;
        if !output.status.success() {
            return Err(AgentError::Exit {
                code: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            });
        }
        reply::parse(
            &String::from_utf8_lossy(&output.stdout),
            request.schema.is_some(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request() -> AgentRequest {
        AgentRequest {
            label: "probe".into(),
            agent: None,
            prompt: "hi".into(),
            model: Some("haiku".into()),
            schema: Some(json!({"type": "object"})),
            allowed_tools: vec!["Read".into(), "Bash(git *)".into()],
            cwd: PathBuf::from("."),
        }
    }

    #[test]
    fn argv_carries_every_option_with_allowed_tools_last() {
        let cc = ClaudeCode {
            plugin_dirs: vec![PathBuf::from("/craft"), PathBuf::from("/extra")],
            ..ClaudeCode::default()
        };
        assert_eq!(
            cc.argv(&request()),
            [
                "-p",
                "--output-format",
                "json",
                "--permission-prompts",
                "none",
                "--setting-sources",
                "project,local",
                "--plugin-dir",
                "/craft",
                "--plugin-dir",
                "/extra",
                "--model",
                "haiku",
                "--json-schema",
                r#"{"type":"object"}"#,
                "--allowedTools",
                "Read",
                "Bash(git *)",
            ]
        );
    }

    #[test]
    fn argv_leaves_out_what_the_request_does_not_set() {
        let bare = AgentRequest {
            model: None,
            schema: None,
            allowed_tools: Vec::new(),
            ..request()
        };
        let argv = ClaudeCode::default().argv(&bare);
        for flag in ["--plugin-dir", "--model", "--json-schema", "--allowedTools"] {
            assert!(!argv.iter().any(|a| a == flag), "{flag} in {argv:?}");
        }
        assert_eq!(argv.last().map(String::as_str), Some("project,local"));
    }
}
