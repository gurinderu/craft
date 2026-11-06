//! The single JSON object `claude -p --output-format json` prints. Observed on claude 2.1.319:
//! the final text in `result`, the shaped answer in `structured_output` under `--json-schema`, a
//! failed turn as `is_error` with a `subtype` other than `success`, the spend in `total_cost_usd`
//! and per model in `modelUsage` (the session's own `usage`, snake case, beside it), and the
//! refused tool uses in `permission_denials`.

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
mod tests {
    use super::*;
    use serde_json::{Value, json};

    const REAL: &str = include_str!("../tests/fixtures/reply-success.json");

    fn real_with(edit: impl FnOnce(&mut serde_json::Map<String, Value>)) -> String {
        let mut v: Value = serde_json::from_str(REAL).unwrap();
        edit(v.as_object_mut().unwrap());
        v.to_string()
    }

    #[test]
    fn real_reply_yields_the_shaped_answer_text_usage_and_cost() {
        let r = parse(REAL, true).unwrap();
        assert_eq!(r.structured, Some(json!({"ok": true, "note": "Done."})));
        assert_eq!(r.text.as_deref(), Some(r#"{"ok":true,"note":"Done."}"#));
        assert_eq!(
            r.usage,
            Usage {
                input: 2,
                output: 75,
                cache_read: 0,
                cache_write: 18093
            }
        );
        assert!((r.cost_usd - 0.003_656_3).abs() < 1e-9);
        assert!(r.denials.is_empty());
    }

    #[test]
    fn usage_sums_every_model_over_the_session_usage() {
        let s = real_with(|o| {
            o.insert(
                "modelUsage".into(),
                json!({
                    "a": {"inputTokens": 2, "outputTokens": 10, "cacheReadInputTokens": 100, "cacheCreationInputTokens": 50},
                    "b": {"inputTokens": 1, "outputTokens": 5}
                }),
            );
        });
        assert_eq!(
            parse(&s, false).unwrap().usage,
            Usage {
                input: 3,
                output: 15,
                cache_read: 100,
                cache_write: 50
            }
        );
    }

    #[test]
    fn session_usage_when_no_model_is_listed() {
        let s = real_with(|o| {
            o.remove("modelUsage");
        });
        assert_eq!(
            parse(&s, false).unwrap().usage,
            Usage {
                input: 2,
                output: 75,
                cache_read: 0,
                cache_write: 18093
            }
        );
    }

    #[test]
    fn a_failed_turn_is_an_error_with_its_subtype() {
        let s = real_with(|o| {
            o.insert("subtype".into(), json!("error_max_turns"));
        });
        assert!(
            matches!(parse(&s, false), Err(AgentError::Failed { subtype }) if subtype == "error_max_turns")
        );
        let s = real_with(|o| {
            o.insert("is_error".into(), json!(true));
        });
        assert!(matches!(parse(&s, false), Err(AgentError::Failed { .. })));
    }

    #[test]
    fn a_schema_without_an_object_answer_is_an_error_but_text_alone_is_fine() {
        let s = real_with(|o| {
            o.insert("structured_output".into(), json!("x"));
        });
        assert!(matches!(
            parse(&s, true),
            Err(AgentError::NoStructuredOutput)
        ));
        assert_eq!(parse(&s, false).unwrap().structured, None);
    }

    #[test]
    fn unreadable_replies_are_errors() {
        for s in ["not json", "null", "[]", ""] {
            assert!(
                matches!(
                    parse(s, false),
                    Err(AgentError::Unreadable(_) | AgentError::NotAnObject)
                ),
                "{s}"
            );
        }
    }

    #[test]
    fn denials_read_as_tool_and_squashed_detail_cut_short() {
        let long = "x".repeat(200);
        let s = real_with(|o| {
            o.insert(
                "permission_denials".into(),
                json!([
                    {"tool_name": "Bash", "tool_input": {"command": "rtk   git\nstatus"}},
                    {"tool_name": "Write", "tool_input": {"file_path": "/x"}},
                    {"tool_name": "Bash", "tool_input": {"command": long}},
                    {}
                ]),
            );
        });
        let d = parse(&s, false).unwrap().denials;
        assert_eq!(d[0], "Bash(rtk git status)");
        assert_eq!(d[1], "Write(/x)");
        assert_eq!(d[2].len(), "Bash()".len() + DENIAL_DETAIL);
        assert_eq!(d[3], "?()");
    }
}
