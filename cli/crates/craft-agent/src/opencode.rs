//! The `opencode` backend: each run is one `opencode run --format json` subprocess in the request's
//! directory — the reviewed repository, as opencode has no directory flag — on the request's agent,
//! its prompt on stdin (realm @nick/craft, nodes #499, #502). opencode has no read-only switch: a
//! task is read-only by its agent's own permissions, which the caller chooses. The reply is the
//! text of the last step ([`stream::read`]); its answer is the last ```` ```craft-answer ```` block
//! in it, read as pi's is ([`crate::pi::answer::answer_of`]). The login and the default model are
//! opencode's own.

pub mod stream;

use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;

use crate::pi::answer::answer_of;
use crate::{AgentBackend, AgentError, AgentReply, AgentRequest, subprocess};

/// Runs agents through `opencode run`.
#[derive(Debug, Clone)]
pub struct OpenCode {
    /// The CLI to run, `opencode` by default.
    pub command: PathBuf,
    /// A run that takes longer is killed.
    pub timeout: Duration,
    /// Variables set for every run on top of craft's own environment.
    pub env: Vec<(String, String)>,
    /// Whether each run's session is archived (`--archived`, 2.x); a 1.x `run` takes no such flag.
    pub archived: bool,
}

impl Default for OpenCode {
    fn default() -> Self {
        Self {
            command: PathBuf::from("opencode"),
            timeout: Duration::from_hours(2),
            env: Vec::new(),
            archived: true,
        }
    }
}

impl OpenCode {
    /// The argv for one run, its session archived — out of the session lists — when `archived`
    /// (2.x); the prompt goes on stdin.
    #[must_use]
    pub fn argv(request: &AgentRequest, archived: bool) -> Vec<String> {
        let mut argv: Vec<String> = ["run", "--format", "json"].map(String::from).into();
        if let Some(agent) = &request.agent {
            argv.push("--agent".into());
            argv.push(agent.clone());
        }
        if let Some(model) = &request.model {
            argv.push("--model".into());
            argv.push(model.clone());
        }
        if archived {
            argv.push("--archived".into());
        }
        argv
    }
}

/// What a failed run said: its error events' messages when it printed any, else stdout as it is.
fn said(errors: &[String], stdout: &[u8]) -> String {
    if errors.is_empty() {
        String::from_utf8_lossy(stdout).trim().to_owned()
    } else {
        errors.join("\n")
    }
}

impl AgentBackend for OpenCode {
    async fn run(&self, request: &AgentRequest) -> Result<AgentReply, AgentError> {
        let argv = Self::argv(request, self.archived);
        let spawn = subprocess::Spawn {
            program: &self.command,
            args: &argv,
            cwd: &request.cwd,
            env: &self.env,
            stdin: request.prompt.as_bytes(),
        };
        let output = tokio::time::timeout(self.timeout, subprocess::output(spawn))
            .await
            .map_err(|_elapsed| AgentError::TimedOut(self.timeout))??;
        let read = stream::read(&String::from_utf8_lossy(&output.stdout));
        let answer = answer_of(&read.text);
        // An error event with no answer is a failure even on a clean exit: its words may say the
        // login or the usage limit.
        if !output.status.success() || (answer.is_none() && !read.errors.is_empty()) {
            return Err(AgentError::Quit {
                code: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
                stdout: said(&read.errors, &output.stdout),
            });
        }
        let Some(answer) = answer else {
            return Err(AgentError::NoAnswer {
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
                stdout: read.text.trim().to_owned(),
            });
        };
        Ok(AgentReply {
            structured: Some(Value::Object(answer)),
            text: Some(read.text),
            usage: read.usage,
            cost_usd: read.cost_usd,
            denials: Vec::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argv_names_the_agent_and_model_only_when_set() {
        let request = AgentRequest {
            label: "t".into(),
            agent: Some("review-task".into()),
            prompt: "--do this".into(),
            model: Some("anthropic/claude-x#high".into()),
            schema: None,
            allowed_tools: Vec::new(),
            cwd: PathBuf::from("/repo"),
        };
        assert_eq!(
            OpenCode::argv(&request, true),
            [
                "run",
                "--format",
                "json",
                "--agent",
                "review-task",
                "--model",
                "anthropic/claude-x#high",
                "--archived"
            ]
        );
        let bare = AgentRequest {
            agent: None,
            model: None,
            ..request
        };
        assert_eq!(
            OpenCode::argv(&bare, true),
            ["run", "--format", "json", "--archived"]
        );
        assert_eq!(
            OpenCode::argv(&bare, false),
            ["run", "--format", "json"],
            "a 1.x run is not archived"
        );
    }
}
