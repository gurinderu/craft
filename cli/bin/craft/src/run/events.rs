//! The progress of `craft review run --events json` as a stream a host's view reads (realm
//! @nick/craft, node #506): one JSON object per line on stderr, stdout left to the answer. Without
//! the flag, stderr carries the human progress lines as before and no event.
//!
//! One thread of the sink's own writes the stream (realm @nick/craft, node #690). An event is
//! offered to a bounded queue and never waited for: one the queue has no room for is lost, and a
//! delegated task whose event is lost is not handed out (`delegate.rs`). A line the stream did not
//! take whole is the last — nothing is written after it. The run waits for what it offered only as
//! it ends, and no longer than its exit wait.

use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

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

/// How many events may wait for the writer: not fewer than one round's dispatches.
const CAPACITY: usize = 1024;
/// How long a run waits, as it ends, for the events it offered and the writer has not written.
const EXIT_WAIT: Duration = Duration::from_secs(2);

/// What the writer has told, read by whoever offers an event or waits for one.
#[derive(Debug, Default)]
struct Told {
    /// How many events the writer took off the queue, written or lost.
    handled: Mutex<u64>,
    /// Set once a line was not taken whole: the stream is over.
    broken: AtomicBool,
    /// Woken as each event is taken off the queue.
    advanced: Condvar,
}

/// The event stream's queue and its one writer.
#[derive(Debug)]
struct Queue {
    offered: SyncSender<Event>,
    /// How many events the queue took.
    queued: AtomicU64,
    told: Arc<Told>,
    wait: Duration,
}

impl Queue {
    /// A queue of `capacity` events, at least one, and a thread of its own that writes each as
    /// one line through `write`, which says whether the stream took it whole. A writer that could
    /// not start takes the queue's other end with it: every event is then refused.
    fn with(
        capacity: usize,
        wait: Duration,
        write: impl FnMut(&str) -> bool + Send + 'static,
    ) -> Self {
        let (offered, taken) = sync_channel(capacity);
        let told = Arc::new(Told::default());
        // Detached: it ends with the stream, and a run that returns early does not wait for it.
        let _writer = thread::Builder::new().name("craft-events".into()).spawn({
            let told = Arc::clone(&told);
            move || drain(&taken, &told, write)
        });
        Self {
            offered,
            queued: AtomicU64::new(0),
            told,
            wait,
        }
    }

    /// Offers an event: whether the queue took it. It never waits.
    fn offer(&self, event: Event) -> bool {
        if self.told.broken.load(Ordering::SeqCst) {
            return false;
        }
        if self.offered.try_send(event).is_err() {
            return false;
        }
        self.queued.fetch_add(1, Ordering::SeqCst);
        true
    }

    /// Waits, no longer than `wait`, for the events the queue took to be written; a stream that
    /// broke ends the wait at once.
    fn finish(&self) {
        let queued = self.queued.load(Ordering::SeqCst);
        let deadline = Instant::now() + self.wait;
        let told = &*self.told;
        let mut handled = told.handled.lock().unwrap_or_else(PoisonError::into_inner);
        while *handled < queued && !told.broken.load(Ordering::SeqCst) {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return;
            }
            handled = told
                .advanced
                .wait_timeout(handled, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }
}

/// The writer's whole work: each event as one line, in the order offered, until one is not taken
/// whole — nothing is written after it. The caller holds the queue's other end and drops it once
/// this returns: every later offer is then refused.
fn drain(taken: &Receiver<Event>, told: &Told, mut write: impl FnMut(&str) -> bool) {
    while let Ok(event) = taken.recv() {
        let line = serde_json::to_string(&event).map(|mut line| {
            line.push('\n');
            line
        });
        let whole = line.is_ok_and(|line| write(&line));
        if !whole {
            told.broken.store(true, Ordering::SeqCst);
        }
        // Said before the waking, so whoever wakes reads the break with the count.
        *told.handled.lock().unwrap_or_else(PoisonError::into_inner) += 1;
        told.advanced.notify_all();
        if !whole {
            return;
        }
    }
}

/// The process's stderr, one line at a time.
fn to_stderr(line: &str) -> bool {
    std::io::stderr().lock().write_all(line.as_bytes()).is_ok()
}

/// Where the progress goes: human lines, or the event stream.
#[derive(Debug, Clone)]
pub(crate) struct Sink(Mode);

#[derive(Debug, Clone)]
enum Mode {
    Lines,
    Events(Arc<Queue>),
}

impl Sink {
    /// The process's sink: the event stream with `json`, human lines without.
    pub(super) fn new(json: bool) -> Self {
        Self::with(json, CAPACITY, EXIT_WAIT, to_stderr)
    }

    /// A sink whose event stream holds `capacity` events, at least one, waits `wait` as it ends
    /// and writes each line through `write`, which says whether the stream took it whole.
    pub(super) fn with(
        json: bool,
        capacity: usize,
        wait: Duration,
        write: impl FnMut(&str) -> bool + Send + 'static,
    ) -> Self {
        if json {
            Self(Mode::Events(Arc::new(Queue::with(capacity, wait, write))))
        } else {
            Self(Mode::Lines)
        }
    }

    /// Whether this is the event stream.
    pub(super) fn json(&self) -> bool {
        matches!(self.0, Mode::Events(_))
    }

    /// A progress line: printed, or offered as a `log` event. One not written loses only progress.
    pub(crate) fn log(&self, line: &str) {
        match &self.0 {
            Mode::Events(queue) => {
                let _lost = queue.offer(Event::Log {
                    line: line.to_owned(),
                });
            }
            Mode::Lines => {
                let _unlogged = writeln!(std::io::stderr().lock(), "{line}");
            }
        }
    }

    /// An event, offered to the event stream alone. One not written loses only progress.
    pub(crate) fn emit(&self, event: Event) {
        let _lost = self.emitted(event);
    }

    /// An event offered to the event stream: whether the queue took it — what a delegated task's
    /// dispatch stands on (`delegate.rs`).
    pub(crate) fn emitted(&self, event: Event) -> bool {
        match &self.0 {
            Mode::Events(queue) => queue.offer(event),
            Mode::Lines => false,
        }
    }

    /// Waits, no longer than its exit wait, for the events offered to be written.
    pub(crate) fn finish(&self) {
        if let Mode::Events(queue) = &self.0 {
            queue.finish();
        }
    }
}

/// A test's event stream, for this module's tests, for `delegate`'s and for the run's end.
#[cfg(test)]
#[path = "events_stream_tests.rs"]
pub(super) mod stream;

#[cfg(test)]
#[path = "events_tests.rs"]
mod tests;
