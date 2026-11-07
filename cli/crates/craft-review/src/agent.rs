//! What a task asks of the host's agent, in host-neutral tokens: which agent kind it runs on and
//! which model. Each host's driver maps a token to its own name (the Claude Code driver,
//! `lib/cli-review-task.mjs`: `rust-reviewer` is `craft:rust-reviewer`, `nix-reviewer` is
//! `craft:nix-reviewer`); a profile naming a token this enum lacks is refused when it is read.

use serde::{Deserialize, Serialize};

/// The agent a task runs on, when not the host's default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentKind {
    /// The Rust reviewer, the agent the engine's Rust lenses run on.
    RustReviewer,
    /// The Nix reviewer, the agent the engine's Nix lenses run on.
    NixReviewer,
}

/// The model a task runs on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Model {
    Opus,
    Sonnet,
    Haiku,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_tokens_are_host_neutral_and_unknown_ones_are_refused() {
        assert_eq!(json!(AgentKind::RustReviewer), json!("rust-reviewer"));
        assert_eq!(json!(AgentKind::NixReviewer), json!("nix-reviewer"));
        assert_eq!(json!(Model::Opus), json!("opus"));
        serde_json::from_value::<AgentKind>(json!("craft:rust-reviewer")).unwrap_err();
        serde_json::from_value::<Model>(json!("gpt")).unwrap_err();
    }
}
