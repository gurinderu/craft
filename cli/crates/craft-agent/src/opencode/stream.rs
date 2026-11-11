//! What `opencode run --format json` printed: one JSON event per line (observed on opencode 2.2.7
//! and 1.19.5; realm @nick/craft, node #502). A step opens with `step_start`, carries its `text`
//! parts (`part.text`, each part with an `id` of its own) and tool uses, and closes with
//! `step_finish`, whose `part.tokens` and `part.cost` are what the step spent. A failure is an
//! `error` event (`error.message`, `error.type`) on stdout, with a failed exit. The reply is the
//! text of the last step: earlier steps are the agent's work before it, not its answer.

use serde_json::Value;

use crate::Usage;

/// What one run printed, read.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Stream {
    /// The last step's text parts, in order, joined by newlines.
    pub text: String,
    /// Every step's tokens, reasoning counted as output.
    pub usage: Usage,
    pub cost_usd: f64,
    /// Each `error` event's message.
    pub errors: Vec<String>,
}

/// A step's text parts by id: a part printed again replaces its earlier text.
#[derive(Default)]
struct Step(Vec<(String, String)>);

impl Step {
    fn add(&mut self, part: &Value) {
        let text = str_at(part, "text").to_owned();
        let id = str_at(part, "id").to_owned();
        match self.0.iter_mut().find(|(i, _)| !id.is_empty() && *i == id) {
            Some(slot) => slot.1 = text,
            None => self.0.push((id, text)),
        }
    }

    fn text(&self) -> String {
        let parts: Vec<&str> = self.0.iter().map(|(_, t)| t.as_str()).collect();
        parts.join("\n")
    }
}

fn str_at<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn count(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or(0)
}

/// A finished step's spend added to the run's.
fn spent(s: &mut Stream, part: &Value) {
    if let Some(t) = part.get("tokens") {
        let cache = t.get("cache").unwrap_or(&Value::Null);
        s.usage.add(&Usage {
            input: count(t, "input"),
            output: count(t, "output").saturating_add(count(t, "reasoning")),
            cache_read: count(cache, "read"),
            cache_write: count(cache, "write"),
        });
    }
    s.cost_usd += part.get("cost").and_then(Value::as_f64).unwrap_or(0.0);
}

/// An error event's words: its message, else its type, else the event as printed.
fn error_of(event: &Value) -> String {
    let error = event.get("error").unwrap_or(&Value::Null);
    [str_at(error, "message"), str_at(error, "type")]
        .into_iter()
        .find(|s| !s.is_empty())
        .map_or_else(|| event.to_string(), str::to_owned)
}

/// The run as its events tell it; a line that is not a JSON event is passed over.
#[must_use]
pub fn read(out: &str) -> Stream {
    let mut s = Stream::default();
    let mut step = Step::default();
    for event in out
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
    {
        let part = event.get("part").unwrap_or(&Value::Null);
        match str_at(&event, "type") {
            "step_start" => step = Step::default(),
            "text" => step.add(part),
            "step_finish" => spent(&mut s, part),
            "error" => s.errors.push(error_of(&event)),
            _ => {}
        }
    }
    s.text = step.text();
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_last_steps_text_is_the_reply_and_every_steps_spend_is_counted() {
        let out = r#"{"type":"step_start","part":{}}
{"type":"text","part":{"id":"p1","text":"looking"}}
{"type":"tool_use","part":{"tool":"shell"}}
{"type":"step_finish","part":{"cost":0.5,"tokens":{"input":10,"output":2,"reasoning":1,"cache":{"read":7,"write":1}}}}
not json
{"type":"step_start","part":{}}
{"type":"text","part":{"id":"p2","text":"draft"}}
{"type":"text","part":{"id":"p3","text":"```craft-answer"}}
{"type":"text","part":{"id":"p2","text":"final"}}
{"type":"step_finish","part":{"cost":0.25,"tokens":{"input":1,"output":1}}}
"#;
        let s = read(out);
        assert_eq!(s.text, "final\n```craft-answer");
        assert_eq!(
            s.usage,
            Usage {
                input: 11,
                output: 4,
                cache_read: 7,
                cache_write: 1
            }
        );
        assert!((s.cost_usd - 0.75).abs() < 1e-9);
        assert!(s.errors.is_empty());
    }

    #[test]
    fn an_error_event_says_its_message_else_its_type() {
        let out = r#"{"type":"error","error":{"type":"provider.no-route","message":"Model unavailable: nope/none"}}
{"type":"error","error":{"type":"unknown"}}"#;
        let s = read(out);
        assert_eq!(s.errors, ["Model unavailable: nope/none", "unknown"]);
        assert_eq!(s.text, "");
    }
}
