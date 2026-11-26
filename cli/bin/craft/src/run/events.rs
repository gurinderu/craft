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
/// - `{"type":"task","key":n,"id":…,"label":…,"agent":…|null,"model":…|null,"cwd":…,"prompt":…}` —
///   with `--delegate`, a task for the delegating process to run in the repository `cwd` names, its
///   reply awaited on stdin under `key` (`delegate.rs`).
/// - `{"type":"task_cancelled","key":n}` — with `--delegate`, a task no longer awaited: stop it.
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
    Task {
        key: u64,
        id: String,
        label: String,
        agent: Option<String>,
        model: Option<String>,
        cwd: String,
        prompt: String,
    },
    TaskCancelled {
        key: u64,
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

    /// An event, written only in the event stream. A failed write loses only progress.
    pub(crate) fn emit(self, event: &Event) {
        let _lost = self.emitted(event);
    }

    /// An event written to the event stream: whether it was — what a delegated task's dispatch
    /// stands on (`delegate.rs`).
    pub(crate) fn emitted(self, event: &Event) -> bool {
        self.written(&mut std::io::stderr().lock(), event)
    }

    /// An event written as one line to `out`, whole or not at all: whether it was written.
    fn written(self, out: &mut dyn Write, event: &Event) -> bool {
        self.json && serde_json::to_string(event).is_ok_and(|line| writeln!(out, "{line}").is_ok())
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
        round_trip(
            &Event::Task {
                key: 7,
                id: s("t1"),
                label: s("lens a"),
                agent: Some(s("review-task")),
                model: None,
                cwd: s("/repo"),
                prompt: s("p"),
            },
            &json!({"type": "task", "key": 7, "id": "t1", "label": "lens a", "agent": "review-task", "model": null, "cwd": "/repo", "prompt": "p"}),
        );
        round_trip(
            &Event::TaskCancelled { key: 7 },
            &json!({"type": "task_cancelled", "key": 7}),
        );
    }

    #[test]
    fn an_event_is_written_only_in_the_event_stream_and_says_so() {
        let event = Event::TaskCancelled { key: 1 };
        assert!(Sink { json: true }.emitted(&event));
        assert!(
            !Sink { json: false }.emitted(&event),
            "without --events json no event is written, so no task can be handed out"
        );
    }

    /// Set when this test's binary runs again as a child: there the test writes one event through the process's
    /// stderr, for the parent to read.
    const WRITES_EVENT: &str = "CRAFT_TEST_EVENT_STREAM";

    /// The child's side: one event, written as the binary writes it under `--delegate`.
    fn writes_event() {
        assert!(
            Sink { json: true }.emitted(&Event::TaskCancelled { key: 1 }),
            "the process's stderr took the event"
        );
    }

    #[test]
    fn an_event_leaves_through_the_process_stderr() {
        if std::env::var_os(WRITES_EVENT).is_some() {
            writes_event();
            return;
        }
        // A write through the stderr handle passes the harness's capture, so only this test's own process has its
        // bytes to read: the test runs again as a child. Its name spells no event's kind, which the harness prints.
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "run::events::tests::an_event_leaves_through_the_process_stderr",
            ])
            .env(WRITES_EVENT, "1")
            .output()
            .unwrap();
        let out = String::from_utf8_lossy(&child.stdout);
        assert!(
            child.status.success(),
            "the child writing its event: {}\n{out}",
            child.status
        );
        assert_eq!(
            child.stderr.as_slice(),
            b"{\"type\":\"task_cancelled\",\"key\":1}\n".as_slice(),
            "the event, whole, on stderr"
        );
        assert!(
            !out.contains("task_cancelled"),
            "stdout is left to the answer:\n{out}"
        );
    }

    /// An event stream that takes `n` bytes more, then is gone: its reader stopped reading.
    struct GoneAfter(usize);

    impl std::io::Write for GoneAfter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if self.0 == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "the reader is gone",
                ));
            }
            let take = self.0.min(buf.len());
            self.0 -= take;
            Ok(take)
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn an_event_that_could_not_be_written_whole_is_not_said_written() {
        let event = Event::TaskCancelled { key: 1 };
        let mut out = Vec::new();
        assert!(Sink { json: true }.written(&mut out, &event));
        assert_eq!(
            out.as_slice(),
            b"{\"type\":\"task_cancelled\",\"key\":1}\n".as_slice()
        );
        for taken in [0, 4] {
            assert!(
                !Sink { json: true }.written(&mut GoneAfter(taken), &event),
                "a stream that took {taken} bytes and is gone did not get the event"
            );
        }
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
