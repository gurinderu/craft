//! The `pi` backend: each run is one `pi -p` subprocess in the request's directory, with no session
//! saved, no context files, skills, prompt templates, extensions or MCP servers, and none of the
//! reviewed branch's own pi resources (`--no-approve`) (realm @nick/craft, nodes #495, #499). pi
//! has no sandbox, so the agent gets no tool that writes or edits a file: it prints its answer,
//! which is read from stdout ([`answer::answer_of`]). pi has no schema output; the request's prompt
//! names the schema itself. The login and the default model are the pi session's own.

pub mod answer;

use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;

use crate::{AgentBackend, AgentError, AgentReply, AgentRequest, Usage, subprocess};

/// The tools a task needs: reading the change and its files, git through bash. No write or edit
/// tool. Bash is not contained: pi has no sandbox.
const TOOLS: &str = "read,bash,grep,find,ls";

/// Runs agents through `pi -p`.
#[derive(Debug, Clone)]
pub struct Pi {
    /// The CLI to run, `pi` by default.
    pub command: PathBuf,
    /// A run that takes longer is killed.
    pub timeout: Duration,
    /// Variables set for every run on top of craft's own environment.
    pub env: Vec<(String, String)>,
}

impl Default for Pi {
    fn default() -> Self {
        Self {
            command: PathBuf::from("pi"),
            timeout: Duration::from_hours(2),
            env: Vec::new(),
        }
    }
}

impl Pi {
    /// The argv for one run, the prompt its last word.
    #[must_use]
    pub fn argv(request: &AgentRequest) -> Vec<String> {
        let mut argv: Vec<String> = [
            "-p",
            "--no-session",
            "--no-context-files",
            "--no-skills",
            "--no-prompt-templates",
            "--no-approve",
            "--no-extensions",
            "--no-mcp",
            "--tools",
            TOOLS,
        ]
        .map(String::from)
        .into();
        if let Some(model) = &request.model {
            argv.push("--model".into());
            argv.push(model.clone());
        }
        argv.push("--".into());
        argv.push(request.prompt.clone());
        argv
    }
}

impl AgentBackend for Pi {
    async fn run(&self, request: &AgentRequest) -> Result<AgentReply, AgentError> {
        let argv = Self::argv(request);
        let spawn = subprocess::Spawn {
            program: &self.command,
            args: &argv,
            cwd: &request.cwd,
            env: &self.env,
            stdin: &[],
        };
        let output = tokio::time::timeout(self.timeout, subprocess::output(spawn))
            .await
            .map_err(|_elapsed| AgentError::TimedOut(self.timeout))??;
        if !output.status.success() {
            return Err(subprocess::quit(&output));
        }
        let text = String::from_utf8_lossy(&output.stdout).into_owned();
        let Some(answer) = answer::answer_of(&text) else {
            return Err(subprocess::no_answer(&output));
        };
        Ok(AgentReply {
            structured: Some(Value::Object(answer)),
            text: Some(text),
            usage: Usage::default(),
            cost_usd: 0.0,
            denials: Vec::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argv_isolates_the_process_and_ends_with_the_prompt() {
        let request = AgentRequest {
            label: "t".into(),
            agent: None,
            prompt: "--do this".into(),
            model: Some("openai-codex/gpt-6-luna".into()),
            schema: None,
            allowed_tools: Vec::new(),
            cwd: PathBuf::from("/repo"),
        };
        let argv = Pi::argv(&request);
        assert_eq!(
            argv,
            [
                "-p",
                "--no-session",
                "--no-context-files",
                "--no-skills",
                "--no-prompt-templates",
                "--no-approve",
                "--no-extensions",
                "--no-mcp",
                "--tools",
                "read,bash,grep,find,ls",
                "--model",
                "openai-codex/gpt-6-luna",
                "--",
                "--do this"
            ]
        );
        let bare = AgentRequest {
            model: None,
            ..request
        };
        assert!(!Pi::argv(&bare).iter().any(|a| a == "--model"));
    }
}
