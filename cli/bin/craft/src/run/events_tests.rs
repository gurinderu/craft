//! The event stream's queue and its one writer (realm @nick/craft, node #690), the shape of
//! each event (realm @nick/craft, node #506) and its way out through the process's stderr.

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
            let Event::TaskCancelled { key } = serde_json::from_str::<Event>(line).unwrap() else {
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
    let step =
        json!({"verdict": "Approve", "report": "/r/report.md", "run": "/r", "findings": [{}, {}]});
    round_trip(
        &Event::result(Some(&step), None, 0),
        &json!({"type": "result", "verdict": "Approve", "report": "/r/report.md", "run": "/r", "findings": 2, "exit_code": 0}),
    );
    round_trip(
        &Event::result(None, Some("/q".into()), 1),
        &json!({"type": "result", "verdict": "INCOMPLETE", "report": null, "run": "/q", "findings": 0, "exit_code": 1}),
    );
}
