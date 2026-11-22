//! The model a task runs on, in host-neutral tokens every kind of run shares; each host's driver
//! maps a token to its own name. Which agent a task runs on is its kind's own ([`crate::Kind::Agent`]).

use serde::{Deserialize, Serialize};

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
    use super::Model;
    use serde_json::json;

    #[test]
    fn the_tokens_are_host_neutral_and_unknown_ones_are_refused() {
        assert_eq!(json!(Model::Opus), json!("opus"));
        serde_json::from_value::<Model>(json!("gpt")).unwrap_err();
    }
}
