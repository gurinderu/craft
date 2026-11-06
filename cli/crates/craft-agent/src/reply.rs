//! The single JSON object `claude -p --output-format json` prints. Observed on claude 2.1.319:
//! the final text in `result`, the shaped answer in `structured_output` under `--json-schema`, a
//! failed turn as `is_error` with a `subtype` other than `success`, the spend in `total_cost_usd`
//! and per model in `modelUsage` (the session's own `usage`, snake case, beside it), and the
//! refused tool uses in `permission_denials`. The surface is pinned in (realm @nick/craft, node #449).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::AgentError;

/// Tokens a run spent.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl Usage {
    /// Every token, cached ones included.
    #[must_use]
    pub fn total(&self) -> u64 {
        self.input
            .saturating_add(self.output)
            .saturating_add(self.cache_read)
            .saturating_add(self.cache_write)
    }

    pub fn add(&mut self, other: &Self) {
        self.input = self.input.saturating_add(other.input);
        self.output = self.output.saturating_add(other.output);
        self.cache_read = self.cache_read.saturating_add(other.cache_read);
        self.cache_write = self.cache_write.saturating_add(other.cache_write);
    }
}

/// What one run answered and spent.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AgentReply {
    /// The shaped answer, when a schema was given.
    pub structured: Option<serde_json::Value>,
    /// The final text.
    pub text: Option<String>,
    pub usage: Usage,
    pub cost_usd: f64,
    /// Refused tool uses as `Tool(command or path)`: what to allow when an answer came back empty.
    pub denials: Vec<String>,
}

#[derive(Deserialize)]
struct Raw {
    #[serde(default)]
    subtype: Option<String>,
    #[serde(default)]
    is_error: bool,
    #[serde(default)]
    result: Option<String>,
    #[serde(default)]
    structured_output: Option<serde_json::Value>,
    #[serde(default)]
    total_cost_usd: Option<f64>,
    #[serde(default)]
    usage: Option<SessionUsage>,
    #[serde(default, rename = "modelUsage")]
    model_usage: BTreeMap<String, ModelUsage>,
    #[serde(default)]
    permission_denials: Vec<Denial>,
}

#[derive(Deserialize, Default)]
struct SessionUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
}

#[derive(Deserialize)]
struct Denial {
    #[serde(default)]
    tool_name: Option<String>,
    #[serde(default)]
    tool_input: serde_json::Map<String, serde_json::Value>,
}

const DENIAL_DETAIL: usize = 80;

impl Denial {
    fn describe(&self) -> String {
        let what = ["command", "file_path", "pattern", "skill"]
            .iter()
            .find_map(|k| self.tool_input.get(*k).and_then(serde_json::Value::as_str))
            .unwrap_or_default();
        let squashed: String = what
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(DENIAL_DETAIL)
            .collect();
        format!("{}({squashed})", self.tool_name.as_deref().unwrap_or("?"))
    }
}

impl Raw {
    fn usage(&self) -> Usage {
        if self.model_usage.is_empty() {
            let s = self.usage.as_ref();
            return Usage {
                input: s.map_or(0, |s| s.input_tokens),
                output: s.map_or(0, |s| s.output_tokens),
                cache_read: s.map_or(0, |s| s.cache_read_input_tokens),
                cache_write: s.map_or(0, |s| s.cache_creation_input_tokens),
            };
        }
        let mut sum = Usage::default();
        for m in self.model_usage.values() {
            sum.add(&Usage {
                input: m.input_tokens,
                output: m.output_tokens,
                cache_read: m.cache_read_input_tokens,
                cache_write: m.cache_creation_input_tokens,
            });
        }
        sum
    }
}

/// Reads a reply; with `with_schema`, an answer without a structured object is an error.
///
/// # Errors
/// Unreadable JSON, a failed turn, or a missing structured object under a schema.
pub fn parse(stdout: &str, with_schema: bool) -> Result<AgentReply, AgentError> {
    // Through a Value first: serde would read a struct from a JSON array as well.
    let value: serde_json::Value = serde_json::from_str(stdout).map_err(AgentError::Unreadable)?;
    if !value.is_object() {
        return Err(AgentError::NotAnObject);
    }
    let raw: Raw = serde_json::from_value(value).map_err(AgentError::Unreadable)?;
    let subtype = raw.subtype.clone().unwrap_or_default();
    if raw.is_error || subtype != "success" {
        return Err(AgentError::Failed { subtype });
    }
    let structured = raw
        .structured_output
        .clone()
        .filter(serde_json::Value::is_object);
    if with_schema && structured.is_none() {
        return Err(AgentError::NoStructuredOutput);
    }
    Ok(AgentReply {
        usage: raw.usage(),
        cost_usd: raw
            .total_cost_usd
            .filter(|c| c.is_finite() && *c >= 0.0)
            .unwrap_or(0.0),
        denials: raw
            .permission_denials
            .iter()
            .map(Denial::describe)
            .collect(),
        text: raw.result,
        structured,
    })
}

#[cfg(test)]
mod tests;
