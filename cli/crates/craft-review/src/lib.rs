//! The review: what work it needs, step by step, without starting an agent itself ([`step`],
//! realm @nick/craft, node #453), rendered from craft's content ([`content`], node #452) for the
//! language profiles it reads as data ([`profile`]): a scout per profile, the lens rounds, one dedup, the
//! verifiers ([`phases`]); a later run of a branch builds on its earlier round ([`rereview`]). The
//! types below are the pipeline's skeleton the single-agent probe
//! still runs on.

pub mod absorbed;
pub mod agent;
pub mod chain;
pub mod complexity;
pub mod content;
pub mod coverage;
pub mod critic;
mod dedup;
mod error;
pub mod extra;
mod finished;
pub mod gate;
pub mod git;
#[cfg(test)]
mod golden;
pub mod handoff;
mod harm;
pub mod ledger;
pub mod memory;
#[cfg(test)]
mod parity;
mod paths;
mod phases;
pub mod plan;
pub mod profile;
pub mod project;
pub mod prompts;
pub mod publish;
pub mod report;
pub mod rereview;
pub mod rounds;
pub mod scope;
pub mod settle;
pub mod sources;
pub mod state;
pub mod status;
pub mod step;
pub mod stop;
mod strict;
mod tool;
pub mod units;
mod validate;
mod verify;

use serde::{Deserialize, Serialize};

pub use error::Error;

/// One step of a review: its agents run concurrently, and the next phase waits for them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Phase {
    pub name: String,
    pub agents: Vec<AgentSpec>,
}

/// One agent as content describes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentSpec {
    pub id: String,
    pub prompt: String,
    #[serde(default)]
    pub model: Option<String>,
    /// The JSON Schema the agent's answer must match.
    #[serde(default)]
    pub schema: Option<serde_json::Value>,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
}

impl AgentSpec {
    /// The agent that proves the pipe end to end until content supplies real ones: it lists what
    /// changed between `base` and `HEAD` in the repository it runs in.
    #[must_use]
    pub fn probe(base: &str) -> Self {
        Self {
            id: "probe".into(),
            prompt: format!(
                "Run `git diff --stat {base}...HEAD` in the current repository and answer with the \
                 changed file paths and a one-sentence summary of the change."
            ),
            model: Some("haiku".into()),
            schema: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "files": {"type": "array", "items": {"type": "string"}},
                    "summary": {"type": "string"}
                },
                "required": ["files", "summary"]
            })),
            allowed_tools: vec!["Bash(git *)".into()],
        }
    }
}

/// How much a finding matters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Low,
    Medium,
    High,
    Critical,
}

/// One problem an agent reports.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Finding {
    pub severity: Severity,
    pub title: String,
    pub file: String,
    #[serde(default)]
    pub line: Option<u32>,
    pub body: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_spec_reads_from_json_with_optional_fields_defaulted() {
        let spec: AgentSpec = serde_json::from_str(r#"{"id":"a","prompt":"p"}"#).unwrap();
        assert_eq!(
            spec,
            AgentSpec {
                id: "a".into(),
                prompt: "p".into(),
                model: None,
                schema: None,
                allowed_tools: Vec::new()
            }
        );
    }

    #[test]
    fn the_probe_names_its_base_and_asks_for_an_object() {
        let p = AgentSpec::probe("origin/main");
        assert!(p.prompt.contains("origin/main...HEAD"));
        assert_eq!(
            p.schema.as_ref().and_then(|s| s.get("type")),
            Some(&serde_json::json!("object"))
        );
    }

    #[test]
    fn severities_order_from_low_to_critical() {
        assert!(Severity::Low < Severity::Critical);
        let f: Finding =
            serde_json::from_str(r#"{"severity":"high","title":"t","file":"a.rs","body":"b"}"#)
                .unwrap();
        assert_eq!((f.severity, f.line), (Severity::High, None));
    }
}
