//! The `anthropic-api` backend: the Messages API driven directly. Not implemented yet.

use crate::{AgentBackend, AgentError, AgentReply, AgentRequest};

/// Runs agents through the Anthropic API. Every run fails with [`AgentError::NotYet`].
#[derive(Debug, Clone, Copy, Default)]
pub struct AnthropicApi;

impl AgentBackend for AnthropicApi {
    async fn run(&self, _request: &AgentRequest) -> Result<AgentReply, AgentError> {
        Err(AgentError::NotYet {
            backend: "anthropic-api",
        })
    }
}
