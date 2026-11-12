//! The `anthropic-api` backend: the Messages API driven directly. Not implemented yet.

use crate::{AgentBackend, AgentError, AgentReply, AgentRequest};

/// Runs agents through the Anthropic API. Every run fails with [`AgentError::NotYet`].
#[derive(Debug, Clone, Copy, Default)]
pub struct AnthropicApi;

impl AgentBackend for AnthropicApi {
    fn run(
        &self,
        _request: &AgentRequest,
    ) -> impl Future<Output = Result<AgentReply, AgentError>> + Send {
        std::future::ready(Err(AgentError::NotYet {
            backend: "anthropic-api",
        }))
    }
}
