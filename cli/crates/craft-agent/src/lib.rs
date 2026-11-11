//! One agent run through a backend, and many under a concurrency cap.
//!
//! A backend turns an [`AgentRequest`] into an [`AgentReply`]: the shaped answer when a schema was
//! given, the final text, and what the run spent. [`claude_code::ClaudeCode`] runs the `claude` CLI,
//! [`codex::Codex`] the `codex` CLI and [`pi::Pi`] the `pi` CLI, one subprocess per agent;
//! [`anthropic_api::AnthropicApi`] is a stub until the API backend lands.

pub mod anthropic_api;
pub mod claude_code;
pub mod codex;
pub mod pi;
mod process_group;
mod reply;
pub mod runner;
mod subprocess;

use std::future::Future;
use std::path::PathBuf;

pub use process_group::settle_stops;
pub use reply::{AgentReply, Usage};

/// One agent to run.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentRequest {
    /// Names the agent in events and errors.
    pub label: String,
    /// Sent to the agent as its first user turn.
    pub prompt: String,
    /// The backend's own default when absent.
    pub model: Option<String>,
    /// When present, the agent must answer with a value of this JSON Schema.
    pub schema: Option<serde_json::Value>,
    /// Tool uses allowed without a prompt; every other use is refused.
    pub allowed_tools: Vec<String>,
    /// Where the agent runs.
    pub cwd: PathBuf,
}

/// Why a run gave no answer.
#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("could not start `{command}`: {source}")]
    Spawn {
        command: String,
        #[source]
        source: std::io::Error,
    },
    #[error("talking to the agent process failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("timed out after {0:?}")]
    TimedOut(std::time::Duration),
    #[error("exited with {code:?}: {stderr}")]
    Exit { code: Option<i32>, stderr: String },
    #[error("the reply is unreadable: {0}")]
    Unreadable(#[source] serde_json::Error),
    #[error("the reply is not a JSON object")]
    NotAnObject,
    #[error("the agent's turn failed ({subtype})")]
    Failed { subtype: String },
    #[error("a schema was given but the reply carries no structured object")]
    NoStructuredOutput,
    #[error("the {backend} backend is not implemented yet")]
    NotYet { backend: &'static str },
    /// A host CLI's failed exit, both streams kept: a missing login or a usage limit may be said
    /// on either.
    #[error("exited with {code:?}: {stderr}")]
    Quit {
        code: Option<i32>,
        stderr: String,
        stdout: String,
    },
    /// A host CLI that exited cleanly with no answer to read.
    #[error("gave no answer")]
    NoAnswer { stderr: String, stdout: String },
    /// Never started: the batch was stopped before its turn came.
    #[error("not started: the batch was stopped before it")]
    NotStarted,
}

/// Runs one agent.
pub trait AgentBackend: Send + Sync {
    fn run(
        &self,
        request: &AgentRequest,
    ) -> impl Future<Output = Result<AgentReply, AgentError>> + Send;
}
