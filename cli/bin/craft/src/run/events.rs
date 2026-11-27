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

/// A test's event stream, for this module's tests and `delegate`'s.
#[cfg(test)]
pub(super) mod stream {
    use std::sync::{Arc, Condvar, Mutex, PoisonError};
    use std::thread::{self, ThreadId};
    use std::time::{Duration, Instant};

    /// Holds the writer at its first line until opened.
    #[derive(Default)]
    pub(crate) struct Gate {
        /// Whether the writer arrived, and whether it may go on.
        at: Mutex<(bool, bool)>,
        opened: Condvar,
    }

    impl Gate {
        /// The writer's side: says it arrived and waits until the gate opens.
        pub(super) fn reach(&self) {
            let mut at = self.at.lock().unwrap_or_else(PoisonError::into_inner);
            at.0 = true;
            while !at.1 {
                at = self.opened.wait(at).unwrap_or_else(PoisonError::into_inner);
            }
        }

        /// Whether the writer arrived.
        pub(crate) fn arrived(&self) -> bool {
            self.at.lock().unwrap_or_else(PoisonError::into_inner).0
        }

        /// Lets the writer go on.
        pub(crate) fn open(&self) {
            self.at.lock().unwrap_or_else(PoisonError::into_inner).1 = true;
            self.opened.notify_all();
        }
    }

    /// What the stream was given, and by which thread.
    #[derive(Default)]
    pub(crate) struct Kept {
        given: Mutex<(Vec<Vec<u8>>, Vec<ThreadId>)>,
        gate: Option<Arc<Gate>>,
        delay: Duration,
    }

    impl Kept {
        /// A stream that takes a line as soon as it is given.
        pub(crate) fn new() -> Self {
            Self::default()
        }

        /// A stream whose first line waits at `gate`.
        pub(crate) fn at(gate: &Arc<Gate>) -> Self {
            Self {
                gate: Some(Arc::clone(gate)),
                ..Self::default()
            }
        }

        /// A stream that takes `delay` over each line.
        pub(crate) fn slow(delay: Duration) -> Self {
            Self {
                delay,
                ..Self::default()
            }
        }

        fn take(&self, line: &str) -> bool {
            if let Some(gate) = &self.gate {
                gate.reach();
            }
            thread::sleep(self.delay);
            let mut given = self.given.lock().unwrap_or_else(PoisonError::into_inner);
            given.0.push(line.as_bytes().to_vec());
            given.1.push(thread::current().id());
            true
        }

        /// The lines the stream took so far, each with its newline.
        pub(crate) fn lines(&self) -> Vec<String> {
            self.given
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .0
                .iter()
                .map(|line| String::from_utf8_lossy(line).into_owned())
                .collect()
        }

        /// The thread that took each line the stream took so far.
        pub(crate) fn writers(&self) -> Vec<ThreadId> {
            self.given
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .1
                .clone()
        }
    }

    /// The writer of a test sink's stream: what it is given goes to `kept`.
    pub(crate) fn writing(kept: &Arc<Kept>) -> impl FnMut(&str) -> bool + Send + 'static {
        let kept = Arc::clone(kept);
        move |line| kept.take(line)
    }

    /// Up to five seconds for `so` to hold: whether it did.
    pub(crate) fn waited_until(mut so: impl FnMut() -> bool) -> bool {
        let by = Instant::now() + Duration::from_secs(5);
        while !so() && Instant::now() < by {
            thread::sleep(Duration::from_millis(1));
        }
        so()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::sync::mpsc;
    use std::thread;
    use std::thread::ThreadId;
    use std::time::{Duration, Instant};

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

    /// A `task_cancelled` event of `key`.
    fn cancelled(key: u64) -> Event {
        Event::TaskCancelled { key }
    }

    /// The `task_cancelled` keys of the lines the stream took, in their order.
    fn keys_of(kept: &stream::Kept) -> Vec<u64> {
        kept.lines()
            .iter()
            .map(|line| {
                let Event::TaskCancelled { key } = serde_json::from_str::<Event>(line).unwrap()
                else {
                    panic!("not a task_cancelled event: {line}")
                };
                key
            })
            .collect()
    }

    /// `sink.finish()` on a thread of its own; its channel says when it returned, so a finish that
    /// never returns fails the test there instead of hanging it.
    fn finished_elsewhere(sink: &Sink) -> mpsc::Receiver<()> {
        let (done, waited) = mpsc::channel();
        let ending = sink.clone();
        thread::spawn(move || {
            ending.finish();
            let _said = done.send(());
        });
        waited
    }

    /// `sink.emitted(event)` on a thread of its own: its answer within five seconds, `None` while
    /// it is still waiting — an offer never waits.
    fn offered_elsewhere(sink: &Sink, event: Event) -> Option<bool> {
        let (said, answer) = mpsc::channel();
        let offering = sink.clone();
        thread::spawn(move || {
            let _sent = said.send(offering.emitted(event));
        });
        answer.recv_timeout(Duration::from_secs(5)).ok()
    }

    #[test]
    fn an_event_is_offered_only_to_the_event_stream_and_says_so() {
        let event = Event::TaskCancelled { key: 1 };
        let sink = |json| Sink::with(json, 8, Duration::from_secs(5), |_| true);
        assert!(sink(true).emitted(event.clone()));
        assert!(
            !sink(false).emitted(event),
            "without --events json no event is offered, so no task can be handed out"
        );
    }

    #[test]
    fn every_event_is_written_by_the_sink_s_one_thread_and_no_other() {
        let kept = Arc::new(stream::Kept::new());
        let sink = Sink::with(true, 64, Duration::from_secs(5), stream::writing(&kept));
        let offering: Vec<_> = (0..4u64)
            .map(|n| {
                let sink = sink.clone();
                thread::spawn(move || {
                    for key in 0..8 {
                        sink.emit(cancelled(n * 8 + key));
                    }
                    thread::current().id()
                })
            })
            .collect();
        let offered_by: HashSet<ThreadId> = offering
            .into_iter()
            .map(|offerer| offerer.join().unwrap())
            .collect();
        sink.finish();
        let mut keys = keys_of(&kept);
        keys.sort_unstable();
        assert_eq!(
            keys,
            (0..32).collect::<Vec<_>>(),
            "each event offered, once"
        );
        let writers: HashSet<ThreadId> = kept.writers().into_iter().collect();
        assert_eq!(writers.len(), 1, "one thread wrote every line");
        assert!(
            writers.is_disjoint(&offered_by),
            "and it is none of those that offered the events"
        );
    }

    #[test]
    fn no_offer_waits_for_a_write_and_the_exit_waits_for_what_was_offered() {
        let kept = Arc::new(stream::Kept::slow(Duration::from_millis(10)));
        let sink = Sink::with(true, 128, Duration::from_secs(5), stream::writing(&kept));
        for round in 0..64 {
            sink.emit(Event::Round {
                round,
                phase: "lenses".into(),
                tasks: 1,
            });
        }
        sink.emit(Event::result(None, None, 0));
        assert!(
            kept.lines().len() < 65,
            "the stream was still being written after the last offer"
        );
        let exit = Instant::now();
        sink.finish();
        let waited = exit.elapsed();
        let last = kept
            .lines()
            .last()
            .map(|line| serde_json::from_str::<Event>(line).unwrap());
        assert_eq!(
            last,
            Some(Event::result(None, None, 0)),
            "every event offered was written, the result last"
        );
        assert!(
            waited < Duration::from_secs(4),
            "the exit waits only for the lines still to write: {waited:?}"
        );
    }

    #[test]
    fn the_exit_waits_for_a_parked_writer_no_longer_than_its_wait() {
        let gate = Arc::new(stream::Gate::default());
        let kept = Arc::new(stream::Kept::at(&gate));
        let sink = Sink::with(true, 8, Duration::from_millis(100), stream::writing(&kept));
        assert!(sink.emitted(cancelled(1)));
        assert!(
            stream::waited_until(|| gate.arrived()),
            "the writer took the event and is parked in the stream"
        );
        let exit = Instant::now();
        finished_elsewhere(&sink)
            .recv_timeout(Duration::from_secs(5))
            .expect("the exit gives up once its wait is over");
        let waited = exit.elapsed();
        assert!(
            waited >= Duration::from_millis(100),
            "the exit waited its whole wait: {waited:?}"
        );
        assert!(
            waited < Duration::from_secs(4),
            "and no longer: it did not wait for the parked writer: {waited:?}"
        );
        gate.open();
    }

    #[test]
    fn a_broken_stream_ends_the_exit_s_wait_at_once() {
        let sink = Sink::with(true, 8, Duration::from_secs(60), |_| false);
        for key in 0..4 {
            sink.emit(cancelled(key));
        }
        finished_elsewhere(&sink)
            .recv_timeout(Duration::from_secs(5))
            .expect("a broken stream ends the wait, not the whole wait");
    }

    #[test]
    fn a_line_the_stream_did_not_take_whole_is_the_last_and_the_stream_refuses_the_rest() {
        for taken in [0usize, 4] {
            let gate = Arc::new(stream::Gate::default());
            let held = Arc::clone(&gate);
            let given = Arc::new(Mutex::new(Vec::new()));
            let into = Arc::clone(&given);
            let sink = Sink::with(true, 8, Duration::from_secs(5), move |line| {
                held.reach();
                into.lock().unwrap().extend(line.bytes().take(taken));
                taken == line.len()
            });
            assert!(sink.emitted(cancelled(1)), "the queue took the first");
            assert!(
                sink.emitted(cancelled(2)),
                "and the next, the break not yet known"
            );
            gate.open();
            sink.finish();
            assert_eq!(
                given.lock().unwrap().len(),
                taken,
                "the first line's first {taken} bytes, and nothing after it"
            );
            assert!(!sink.emitted(cancelled(3)), "a broken stream takes no more");
        }
    }

    #[test]
    fn a_full_queue_refuses_an_event_at_once_and_takes_one_again_once_its_writer_moved() {
        let gate = Arc::new(stream::Gate::default());
        let kept = Arc::new(stream::Kept::at(&gate));
        let sink = Sink::with(true, 2, Duration::from_secs(5), stream::writing(&kept));
        assert!(sink.emitted(cancelled(1)));
        assert!(stream::waited_until(|| gate.arrived()));
        assert!(
            sink.emitted(cancelled(2)) && sink.emitted(cancelled(3)),
            "the writer holds the first, so two more fit"
        );
        assert_eq!(
            offered_elsewhere(&sink, cancelled(4)),
            Some(false),
            "a full queue refuses at once: nobody waits"
        );
        gate.open();
        assert!(stream::waited_until(|| kept.lines().len() == 3));
        assert!(
            sink.emitted(cancelled(4)),
            "the writer moved on, so the queue takes again"
        );
        sink.finish();
        assert_eq!(keys_of(&kept), [1, 2, 3, 4]);
    }

    #[test]
    fn the_queue_takes_a_round_s_dispatches_behind_the_one_being_written() {
        let gate = Arc::new(stream::Gate::default());
        let kept = Arc::new(stream::Kept::at(&gate));
        let sink = Sink::with(true, CAPACITY, EXIT_WAIT, stream::writing(&kept));
        assert!(sink.emitted(cancelled(0)));
        assert!(stream::waited_until(|| gate.arrived()));
        let round = 256u64;
        assert!(
            (1..=round).all(|key| sink.emitted(cancelled(key))),
            "a round's dispatches fit behind the first"
        );
        let behind = (0..CAPACITY)
            .filter(|_| sink.emitted(cancelled(round + 1)))
            .count();
        assert_eq!(behind, CAPACITY - 256, "the queue is full, and no fuller");
        gate.open();
        sink.finish();
        assert_eq!(kept.lines().len(), CAPACITY + 1);
    }

    /// Set when this test's binary runs again as a child: there the test offers one event to the
    /// process's stderr, for the parent to read.
    const WRITES_EVENT: &str = "CRAFT_TEST_EVENT_STREAM";

    /// The child's side: one event, offered as the binary offers it under `--delegate`.
    fn writes_event() {
        let sink = Sink::new(true);
        assert!(
            sink.emitted(Event::TaskCancelled { key: 1 }),
            "the queue took the event"
        );
        sink.finish();
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
