//! The progress of `craft review run --events json` as a stream a host's view reads (realm
//! @nick/craft, node #506): one JSON object per line on stderr, stdout left to the answer. Without
//! the flag, stderr carries the human progress lines as before and no event.

use std::io::Write;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One event, its kind in `type`. The shapes, field for field:
///
/// - `{"type":"log","line":…}` — a progress line, as the text mode prints it.
/// - `{"type":"phase","name":…}` — the binary moved to a phase.
/// - `{"type":"round","round":n,"phase":…,"tasks":n}` — a round of `tasks` tasks began.
/// - `{"type":"task_started","id":…,"label":…,"agent":…|null,"model":…|null,"tier":…}` — a task's
///   process started: the host's agent it runs as and the host's model, `null` for the host's own,
///   and the binary's tier.
/// - `{"type":"task_finished","id":…,"tokens":n|null,"cost_usd":x|null}` — a task's process gave
///   a reply; `null` where the host did not say what it spent.
/// - `{"type":"task_failed","id":…,"reason":…}` — a task's process gave no reply.
/// - `{"type":"degraded","note":…}` — part of the run ran weaker than asked.
/// - `{"type":"usage_limit","text":…}` — the account's usage limit: no further task starts.
/// - `{"type":"result","verdict":…,"report":…|null,"run":…|null,"findings":n,"exit_code":n}` —
///   the last event: the verdict line, the report file and run directory when there are, how many
///   findings the answer lists, and the exit code.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum Event {
    Log {
        line: String,
    },
    Phase {
        name: String,
    },
    Round {
        round: usize,
        phase: String,
        tasks: usize,
    },
    TaskStarted {
        id: String,
        label: String,
        agent: Option<String>,
        model: Option<String>,
        tier: String,
    },
    TaskFinished {
        id: String,
        tokens: Option<u64>,
        cost_usd: Option<f64>,
    },
    TaskFailed {
        id: String,
        reason: String,
    },
    Degraded {
        note: String,
    },
    UsageLimit {
        text: String,
    },
    Result {
        verdict: String,
        report: Option<String>,
        run: Option<String>,
        findings: usize,
        exit_code: u8,
    },
}

impl Event {
    /// The last event, from the finished step when there is one.
    pub(crate) fn result(step: Option<&Value>, run: Option<String>, exit_code: u8) -> Self {
        let text = |k: &str| {
            step.and_then(|s| s.get(k))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        };
        Self::Result {
            verdict: text("verdict").unwrap_or_else(|| "INCOMPLETE".to_owned()),
            report: text("report"),
            run: text("run").or(run),
            findings: step
                .and_then(|s| s.get("findings"))
                .and_then(Value::as_array)
                .map_or(0, Vec::len),
            exit_code,
        }
    }
}

/// Where the progress goes: human lines, or the event stream.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Sink {
    pub(crate) json: bool,
}

impl Sink {
    /// A progress line: printed, or as a `log` event. A failed write loses only progress.
    pub(crate) fn log(self, line: &str) {
        if self.json {
            self.emit(&Event::Log {
                line: line.to_owned(),
            });
        } else {
            let _unlogged = writeln!(std::io::stderr().lock(), "{line}");
        }
    }

    /// An event, written only in the event stream.
    pub(crate) fn emit(self, event: &Event) {
        if !self.json {
            return;
        }
        if let Ok(line) = serde_json::to_string(event) {
            let _unlogged = writeln!(std::io::stderr().lock(), "{line}");
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn round_trip(event: &Event, wire: &Value) {
        let text = serde_json::to_string(event).unwrap();
        assert_eq!(&serde_json::from_str::<Value>(&text).unwrap(), wire);
        assert_eq!(&serde_json::from_str::<Event>(&text).unwrap(), event);
    }

    #[test]
    fn every_event_has_the_shape_its_doc_names() {
        let s = |v: &str| v.to_owned();
        round_trip(
            &Event::Log { line: s("run=/r") },
            &json!({"type": "log", "line": "run=/r"}),
        );
        round_trip(
            &Event::Phase { name: s("lenses") },
            &json!({"type": "phase", "name": "lenses"}),
        );
        round_trip(
            &Event::Round {
                round: 2,
                phase: s("lenses"),
                tasks: 3,
            },
            &json!({"type": "round", "round": 2, "phase": "lenses", "tasks": 3}),
        );
        round_trip(
            &Event::TaskStarted {
                id: s("t1"),
                label: s("lens a"),
                agent: Some(s("review-task")),
                model: None,
                tier: s("opus"),
            },
            &json!({"type": "task_started", "id": "t1", "label": "lens a", "agent": "review-task", "model": null, "tier": "opus"}),
        );
        round_trip(
            &Event::TaskFinished {
                id: s("t1"),
                tokens: Some(12),
                cost_usd: Some(0.5),
            },
            &json!({"type": "task_finished", "id": "t1", "tokens": 12, "cost_usd": 0.5}),
        );
        round_trip(
            &Event::TaskFailed {
                id: s("t1"),
                reason: s("boom"),
            },
            &json!({"type": "task_failed", "id": "t1", "reason": "boom"}),
        );
        round_trip(
            &Event::Degraded { note: s("n") },
            &json!({"type": "degraded", "note": "n"}),
        );
        round_trip(
            &Event::UsageLimit { text: s("l") },
            &json!({"type": "usage_limit", "text": "l"}),
        );
    }

    #[test]
    fn the_result_reads_the_finished_step_or_says_incomplete() {
        let step = json!({"verdict": "Approve", "report": "/r/report.md", "run": "/r", "findings": [{}, {}]});
        round_trip(
            &Event::result(Some(&step), None, 0),
            &json!({"type": "result", "verdict": "Approve", "report": "/r/report.md", "run": "/r", "findings": 2, "exit_code": 0}),
        );
        round_trip(
            &Event::result(None, Some("/q".into()), 1),
            &json!({"type": "result", "verdict": "INCOMPLETE", "report": null, "run": "/q", "findings": 0, "exit_code": 1}),
        );
    }
}
