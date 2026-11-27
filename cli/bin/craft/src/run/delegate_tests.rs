use std::collections::VecDeque;
use std::io::{BufRead, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use craft_agent::{AgentBackend, AgentError, AgentRequest, Usage};
use serde_json::json;

use super::super::events::stream;
use super::super::events::{Event, Sink};
use super::super::outcome::Outcome;
use super::super::outcome::{outcome_of, stops};
use super::super::task::Task;
use super::Delegate;

fn request(id: &str) -> AgentRequest {
    AgentRequest {
        label: id.into(),
        agent: Some("review-task".into()),
        prompt: "read p.md".into(),
        model: Some("p/m".into()),
        thinking: None,
        schema: None,
        allowed_tools: Vec::new(),
        cwd: PathBuf::from("/repo"),
    }
}

/// What a delegate emitted or logged, kept for the test.
type Kept<T> = Arc<Mutex<Vec<T>>>;

/// A delegate whose events are kept.
fn kept() -> (Delegate, Kept<Event>) {
    let (d, events, _) = kept_logged(true);
    (d, events)
}

/// A delegate whose events and log lines are kept; `writes` whether its events are written.
fn kept_logged(writes: bool) -> (Delegate, Kept<Event>, Kept<String>) {
    let (events, lines) = (
        Arc::new(Mutex::new(Vec::new())),
        Arc::new(Mutex::new(Vec::new())),
    );
    let (seen, said) = (Arc::clone(&events), Arc::clone(&lines));
    let d = Delegate::new(
        move |e| {
            seen.lock().unwrap().push(e);
            writes
        },
        move |l| said.lock().unwrap().push(l.to_owned()),
    );
    (d, events, lines)
}

/// What a delegate reading an input is given to keep its events: it keeps each and says it was
/// written.
fn emit_into(events: &Kept<Event>) -> impl Fn(Event) -> bool + Send + Sync + 'static {
    let seen = Arc::clone(events);
    move |e| {
        seen.lock().unwrap().push(e);
        true
    }
}

/// What a delegate reading an input is given to keep the reply lines it passed over.
fn log_into(lines: &Kept<String>) -> impl Fn(&str) + Send + Sync + 'static {
    let said = Arc::clone(lines);
    move |l| said.lock().unwrap().push(l.to_owned())
}

/// The events and log lines a delegate reading an input keeps, still empty.
fn nothing_kept() -> (Kept<Event>, Kept<String>) {
    (Kept::<Event>::default(), Kept::<String>::default())
}

/// `work` within five seconds: a broken delegate fails the test instead of hanging it.
async fn bounded<T>(work: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), work)
        .await
        .expect("settled within its bound")
}

/// The key of the `n`-th `task` event (from 1), once there is one.
async fn key_of(events: &Mutex<Vec<Event>>, n: usize) -> u64 {
    loop {
        let key = events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| {
                if let Event::Task { key, .. } = e {
                    Some(*key)
                } else {
                    None
                }
            })
            .nth(n - 1);
        if let Some(key) = key {
            return key;
        }
        tokio::task::yield_now().await;
    }
}

fn task(id: &str, label: &str) -> Task {
    Task {
        id: id.into(),
        label: label.into(),
        model: "opus".into(),
        prompt_file: "/r/p.md".into(),
        schema_file: "/r/s.json".into(),
        answer_file: "/r/a.json".into(),
        agent_type: None,
        consumer_agent: None,
        kind: Some("lens".into()),
    }
}

#[tokio::test]
async fn a_task_goes_out_as_an_event_and_its_reply_is_read_as_an_answer() {
    let (d, events) = kept();
    d.name(&[task("t1", "lens a")]);
    let running = tokio::spawn({
        let d = d.clone();
        async move { d.run(&request("t1")).await }
    });
    let key = key_of(&events, 1).await;
    assert_eq!(
        events.lock().unwrap().first(),
        Some(&Event::Task {
            key,
            id: "t1".into(),
            label: "lens a".into(),
            agent: Some("review-task".into()),
            model: Some("p/m".into()),
            cwd: "/repo".into(),
            prompt: "read p.md".into(),
        })
    );
    let text = "looked\n```craft-answer\n{\"findings\":[]}\n```\n";
    d.deliver(&json!({"key": key, "text": text}).to_string())
        .unwrap();
    let reply = bounded(running).await.unwrap().unwrap();
    assert_eq!(reply.structured, Some(json!({"findings": []})));
    assert_eq!(reply.text.as_deref(), Some(text));
    // The reply line carries no usage, cost or denial, and none is made up: the task reads as
    // one whose cost the run cannot say.
    assert_eq!(reply.usage, Usage::default());
    assert_eq!(reply.cost_usd, 0.0);
    assert!(reply.denials.is_empty());
    assert_eq!(
        events.lock().unwrap().len(),
        1,
        "an answered task is not cancelled"
    );
}

#[tokio::test]
async fn a_reply_with_no_answer_is_no_answer_and_an_error_is_a_failed_exit() {
    let (d, events) = kept();
    let running = tokio::spawn({
        let d = d.clone();
        async move { d.run(&request("t1")).await }
    });
    let key = key_of(&events, 1).await;
    d.deliver(&json!({"key": key, "text": "I could not"}).to_string())
        .unwrap();
    assert!(matches!(
        bounded(running).await.unwrap(),
        Err(AgentError::NoAnswer { stdout, .. }) if stdout == "I could not"
    ));
    let failing = tokio::spawn({
        let d = d.clone();
        async move { d.run(&request("t2")).await }
    });
    let key = key_of(&events, 2).await;
    let said =
        "the child session failed (provider.usage-limit): You've hit your usage limit · resets 5pm";
    d.deliver(&json!({"key": key, "error": said}).to_string())
        .unwrap();
    let error = bounded(failing).await.unwrap().unwrap_err();
    assert!(matches!(&error, AgentError::Failed { subtype } if subtype == said));
    assert_eq!(
        error.to_string(),
        format!("the agent's turn failed ({said})"),
        "the run's log and report name the failure"
    );
    // The round reads it as it reads a failed `opencode run`: the usage limit stops the run.
    let host = super::super::host::Host {
        kind: super::super::HostKind::OpenCode,
        models: super::super::models::ModelTable::default(),
        thinking: super::super::models::ThinkingTable::default(),
        command: "opencode".into(),
        agents: None,
        archived: true,
        delegate: None,
    };
    assert!(stops(&host, &error), "no further task starts");
    assert!(matches!(
        outcome_of(&task("t2", "b"), Err(error), &host),
        Outcome::Limit(text) if text.contains("hit your usage limit")
    ));
    // Any other failure is the task's own: it is handed out again, the run goes on.
    let other = AgentError::Failed {
        subtype: "the child session failed (provider.no-route): no route".into(),
    };
    assert!(!stops(&host, &other));
    assert!(matches!(
        outcome_of(&task("t2", "b"), Err(other), &host),
        Outcome::Unanswered { why, .. } if why.contains("provider.no-route")
    ));
}

#[test]
fn a_line_that_is_no_reply_or_names_no_waiting_task_is_passed_over() {
    let (d, _) = kept();
    assert_eq!(format!("{d:?}"), "Delegate");
    assert!(
        d.deliver("not json")
            .unwrap_err()
            .starts_with("it is not a reply")
    );
    assert_eq!(
        d.deliver(r#"{"key":1}"#).unwrap_err(),
        "reply 1 carries neither text nor error"
    );
    assert_eq!(
        d.deliver(r#"{"key":99,"text":"x"}"#).unwrap_err(),
        "no task 99 is awaited"
    );
}

#[tokio::test(start_paused = true)]
async fn a_dispatch_dropped_at_its_deadline_is_cancelled_and_a_late_reply_taken_by_none() {
    let (d, events) = kept();
    let ran = tokio::time::timeout(Duration::from_secs(5), d.run(&request("t1"))).await;
    assert!(ran.is_err(), "the deadline dropped it");
    let key = key_of(&events, 1).await;
    assert_eq!(
        events.lock().unwrap().last(),
        Some(&Event::TaskCancelled { key })
    );
    d.deliver(&json!({"key": key, "text": "late"}).to_string())
        .unwrap_err();
}

#[tokio::test]
async fn each_dispatch_has_its_own_key_so_a_retry_of_a_task_is_not_answered_by_the_last() {
    let (d, events) = kept();
    let first = tokio::spawn({
        let d = d.clone();
        async move { d.run(&request("t1")).await }
    });
    let one = key_of(&events, 1).await;
    let second = tokio::spawn({
        let d = d.clone();
        async move { d.run(&request("t1")).await }
    });
    let two = key_of(&events, 2).await;
    assert_ne!(one, two);
    d.deliver(&json!({"key": two, "error": "second"}).to_string())
        .unwrap();
    d.deliver(&json!({"key": one, "error": "first"}).to_string())
        .unwrap();
    assert!(
        matches!(bounded(first).await.unwrap(), Err(AgentError::Failed { subtype }) if subtype == "first")
    );
    assert!(
        matches!(bounded(second).await.unwrap(), Err(AgentError::Failed { subtype }) if subtype == "second")
    );
}

#[tokio::test]
async fn once_the_input_ends_every_waiting_dispatch_fails_and_every_later_one_at_once() {
    let (d, events) = kept();
    let running = tokio::spawn({
        let d = d.clone();
        async move { d.run(&request("t1")).await }
    });
    key_of(&events, 1).await;
    // The reader at the input's end, as `on_stdin`'s thread reaches it.
    d.read_replies(std::io::Cursor::new(Vec::new()));
    let error = bounded(running).await.unwrap().unwrap_err();
    assert!(
        matches!(&error, AgentError::HostGone(why) if why == "its input to craft ended"),
        "{error}"
    );
    let later = bounded(d.run(&request("t2"))).await.unwrap_err();
    assert!(matches!(later, AgentError::HostGone(_)), "{later}");
    assert_eq!(
        events.lock().unwrap().len(),
        1,
        "a dispatch after the close sends no event"
    );
}

#[tokio::test]
async fn a_task_event_a_broken_stream_refuses_fails_its_dispatch_at_once() {
    let sink = Sink::with(true, 8, Duration::from_secs(5), |_| false);
    sink.log("a line the stream could not take");
    sink.finish();
    let error = bounded(wired(&sink).run(&request("t1"))).await.unwrap_err();
    assert!(
        matches!(&error, AgentError::HostGone(why) if why == "a task could not be handed to it"),
        "{error}"
    );
}

#[tokio::test]
async fn a_task_event_a_full_stream_refuses_fails_its_dispatch_at_once() {
    let gate = Arc::new(stream::Gate::default());
    let kept = Arc::new(stream::Kept::at(&gate));
    let sink = Sink::with(true, 1, Duration::from_secs(5), stream::writing(&kept));
    let d = wired(&sink);
    sink.log("first");
    assert!(
        stream::waited_until(|| gate.arrived()),
        "the writer holds the first line in the stream"
    );
    sink.log("second");
    let error = bounded(d.run(&request("t1"))).await.unwrap_err();
    assert!(
        matches!(&error, AgentError::HostGone(why) if why == "a task could not be handed to it"),
        "{error}"
    );
    gate.open();
    sink.finish();
    assert_eq!(
        kept.lines(),
        [
            "{\"type\":\"log\",\"line\":\"first\"}\n",
            "{\"type\":\"log\",\"line\":\"second\"}\n"
        ],
        "the lines the queue took are written; the task it refused is not"
    );
}

#[tokio::test(start_paused = true)]
async fn a_cancelled_dispatch_is_said_behind_its_task_on_the_same_stream() {
    let kept = Arc::new(stream::Kept::new());
    let sink = Sink::with(true, 8, Duration::from_secs(5), stream::writing(&kept));
    let d = wired(&sink);
    let ran = tokio::time::timeout(Duration::from_secs(5), d.run(&request("t1"))).await;
    assert!(ran.is_err(), "the deadline dropped it");
    sink.finish();
    let taken: Vec<Event> = kept
        .lines()
        .iter()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let [
        Event::Task { key, .. },
        Event::TaskCancelled { key: cancelled },
    ] = taken.as_slice()
    else {
        panic!("{taken:?}")
    };
    assert_eq!(key, cancelled, "the cancellation names the task before it");
}

#[tokio::test]
async fn a_task_event_that_could_not_be_written_fails_its_dispatch_at_once() {
    let (d, _, _) = kept_logged(false);
    let error = bounded(d.run(&request("t1"))).await.unwrap_err();
    assert!(
        matches!(&error, AgentError::HostGone(why) if why == "a task could not be handed to it"),
        "{error}"
    );
}

/// A delegate wired as `review run` wires it under `--delegate`: its events and its passed-over
/// lines offered to `sink`'s stream.
fn wired(sink: &Sink) -> Delegate {
    let (events, lines) = (sink.clone(), sink.clone());
    Delegate::new(move |e| events.emitted(e), move |l| lines.log(l))
}

#[tokio::test]
async fn the_reader_hands_each_reply_on_and_logs_each_line_it_passes_over() {
    let (d, events, lines) = kept_logged(true);
    let running = tokio::spawn({
        let d = d.clone();
        async move { d.run(&request("t1")).await }
    });
    let key = key_of(&events, 1).await;
    let mut input = b"\xff\xfe not utf-8\n{not json\n\n".to_vec();
    input.extend_from_slice(
        format!(
            "{}\n",
            json!({"key": key, "text": "partial", "error": "it failed"})
        )
        .as_bytes(),
    );
    d.read_replies(std::io::Cursor::new(input));
    let error = bounded(running).await.unwrap().unwrap_err();
    assert!(
        matches!(&error, AgentError::Failed { subtype } if subtype == "it failed"),
        "an error wins over a text: {error}"
    );
    let lines = lines.lock().unwrap();
    assert_eq!(lines.len(), 2, "{lines:?}");
    assert!(lines[0].ends_with("it is not UTF-8"), "{lines:?}");
    assert!(lines[1].contains("it is not a reply"), "{lines:?}");
}

#[tokio::test]
async fn two_dispatches_settled_out_of_order_each_take_their_own_reply() {
    let (d, events) = kept();
    let spawn = |id: &'static str| {
        let d = d.clone();
        tokio::spawn(async move { d.run(&request(id)).await })
    };
    let first = spawn("t1");
    let one = key_of(&events, 1).await;
    let second = spawn("t2");
    let two = key_of(&events, 2).await;
    let answer = |n: u8| format!("```craft-answer\n{{\"n\":{n}}}\n```");
    d.deliver(&json!({"key": two, "text": answer(2)}).to_string())
        .unwrap();
    d.deliver(&json!({"key": one, "text": answer(1)}).to_string())
        .unwrap();
    let got = |r: Result<craft_agent::AgentReply, AgentError>| r.unwrap().structured;
    assert_eq!(got(bounded(first).await.unwrap()), Some(json!({"n": 1})));
    assert_eq!(got(bounded(second).await.unwrap()), Some(json!({"n": 2})));
}

#[derive(clap::Parser)]
struct Cli {
    #[command(flatten)]
    run: super::super::RunArgs,
}

/// The host `review run` would run with, from `argv`.
fn ready_of(argv: &[&str], json: bool) -> Result<super::super::host::Host, String> {
    use clap::Parser;
    let root = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../integrations/claude-code"
    );
    let cli = Cli::try_parse_from([&["craft", "--craft-root", root], argv].concat())
        .map_err(|e| e.to_string())?;
    let sink = Sink::new(json);
    super::super::ready(&cli.run, std::path::Path::new("/nowhere"), &sink).map(|(_, host, _)| host)
}

#[test]
fn delegate_is_opencode_s_with_the_event_stream_and_the_agents_listed_and_runs_no_opencode() {
    // An opencode that is not there: delegated, it is never asked which agents it has.
    let delegated = |agents: &str| {
        ready_of(
            &[
                "--backend",
                "opencode",
                "--delegate",
                "--agents",
                agents,
                "--host-bin",
                "/no/opencode",
            ],
            true,
        )
    };
    let host = delegated("build, review-task,rust-reviewer").unwrap();
    assert!(host.delegate.is_some());
    assert_eq!(
        host.agents,
        Some(vec![
            "build".to_owned(),
            "review-task".to_owned(),
            "rust-reviewer".to_owned()
        ])
    );
    let missing = delegated("build,rust-reviewer").unwrap_err();
    assert!(missing.contains("no `review-task` agent"), "{missing}");
    assert!(
        ready_of(&["--backend", "opencode", "--delegate"], true)
            .unwrap_err()
            .contains("--delegate needs --agents"),
        "no list: fail closed"
    );
    assert!(
        ready_of(&["--backend", "opencode", "--agents", "review-task"], true)
            .unwrap_err()
            .contains("--delegate"),
        "--agents goes only with --delegate"
    );
    let refused = "--delegate is opencode's alone, with --events json";
    assert_eq!(
        ready_of(
            &["--backend", "pi", "--delegate", "--agents", "review-task"],
            true
        )
        .unwrap_err(),
        refused
    );
    assert_eq!(
        ready_of(
            &[
                "--backend",
                "opencode",
                "--delegate",
                "--agents",
                "review-task"
            ],
            false
        )
        .unwrap_err(),
        refused
    );
    assert!(
        ready_of(
            &["--backend", "opencode", "--host-bin", "/no/opencode"],
            true
        )
        .unwrap_err()
        .contains("could not run"),
        "without --delegate opencode is asked first"
    );
}

/// A dispatch of `d` running, and its key once its event is out.
async fn dispatched(
    d: &Delegate,
    events: &Mutex<Vec<Event>>,
    n: usize,
    id: &'static str,
) -> (
    tokio::task::JoinHandle<Result<craft_agent::AgentReply, AgentError>>,
    u64,
) {
    let running = tokio::spawn({
        let d = d.clone();
        async move { d.run(&request(id)).await }
    });
    (running, key_of(events, n).await)
}

#[tokio::test]
async fn a_bad_reply_line_for_a_waiting_key_fails_that_dispatch_at_once_and_the_reader_goes_on() {
    let (d, events, lines) = kept_logged(true);
    let (over, k1) = dispatched(&d, &events, 1, "t1").await;
    let (bytes, k2) = dispatched(&d, &events, 2, "t2").await;
    let (json, k3) = dispatched(&d, &events, 3, "t3").await;
    let (fine, k4) = dispatched(&d, &events, 4, "t4").await;
    let mut input = format!("{{\"key\":{k1},\"text\":\"").into_bytes();
    input.resize(input.len() + super::read::MAX_LINE, b'x');
    input.extend_from_slice(b"\"}\n");
    input.extend_from_slice(format!("{{\"key\":{k2},\"text\":\"").as_bytes());
    input.extend_from_slice(b"\xff\"}\n");
    input.extend_from_slice(format!("{{\"key\":{k3},\"text\":\n").as_bytes());
    input.extend_from_slice(
        format!(
            "{}\n",
            json!({"key": k4, "text": "```craft-answer\n{}\n```"})
        )
        .as_bytes(),
    );
    d.read_replies(std::io::Cursor::new(input));
    let why = |r: Result<craft_agent::AgentReply, AgentError>| match r {
        Err(AgentError::Failed { subtype }) => subtype,
        other => panic!("{other:?}"),
    };
    assert!(why(bounded(over).await.unwrap()).contains("its reply could not be read: it is over"));
    assert!(why(bounded(bytes).await.unwrap()).ends_with("it is not UTF-8"));
    assert!(why(bounded(json).await.unwrap()).contains("it is not a reply"));
    assert!(
        bounded(fine)
            .await
            .unwrap()
            .is_ok_and(|r| r.structured.is_some()),
        "a good line after them is still read"
    );
    assert_eq!(lines.lock().unwrap().len(), 3);
}

/// Input that is interrupted once, then fails.
struct Flaky(u8);

impl std::io::Read for Flaky {
    fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
        self.0 += 1;
        let kind = if self.0 == 1 {
            std::io::ErrorKind::Interrupted
        } else {
            std::io::ErrorKind::BrokenPipe
        };
        Err(std::io::Error::new(kind, "flaky"))
    }
}

#[tokio::test]
async fn an_interrupted_read_is_tried_again_and_a_read_error_is_said_and_closes_the_delegate() {
    let (d, _, lines) = kept_logged(true);
    let mut input = std::io::BufReader::new(Flaky(0));
    d.read_replies(&mut input);
    assert_eq!(input.get_ref().0, 2, "the interrupted read was tried again");
    let lines = lines.lock().unwrap().clone();
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert!(
        lines[0].contains("the reply input could not be read (flaky)"),
        "{lines:?}"
    );
    let later = bounded(d.run(&request("t1"))).await.unwrap_err();
    assert!(matches!(later, AgentError::HostGone(_)), "{later}");
}

/// The delegating process's end of the input, as a test holds it: it says nothing until it is
/// handed a line, and ends when told — as that process's stdin does while its child sessions run.
#[derive(Clone, Default)]
struct Replies(Arc<Pipe>);

#[derive(Default)]
struct Pipe {
    unread: Mutex<Unread>,
    changed: Condvar,
}

#[derive(Default)]
struct Unread {
    /// The lines said and not read yet.
    lines: VecDeque<Vec<u8>>,
    /// Whether the input ended.
    ended: bool,
}

impl Replies {
    /// The input says `line`.
    fn say(&self, line: String) {
        self.0
            .unread
            .lock()
            .unwrap()
            .lines
            .push_back(line.into_bytes());
        self.0.changed.notify_all();
    }

    /// The input ends.
    fn end(&self) {
        self.0.unread.lock().unwrap().ended = true;
        self.0.changed.notify_all();
    }

    /// The next line said and not read yet, waiting for one; `None` once the input ended.
    fn next_line(&self) -> Option<Vec<u8>> {
        let mut unread = self.0.unread.lock().unwrap();
        while unread.lines.is_empty() && !unread.ended {
            unread = self.0.changed.wait(unread).unwrap();
        }
        unread.lines.pop_front()
    }
}

impl std::io::Read for Replies {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let Some(mut line) = self.next_line() else {
            return Ok(0);
        };
        let take = line.len().min(buf.len());
        buf[..take].copy_from_slice(&line[..take]);
        line.drain(..take);
        if !line.is_empty() {
            // What did not fit waits unread, ahead of the lines said after it.
            self.0
                .unread
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .lines
                .push_front(line);
            self.0.changed.notify_all();
        }
        Ok(take)
    }
}

#[test]
fn a_line_longer_than_the_readers_buffer_is_read_whole() {
    let input = Replies::default();
    // Three of the reader's own buffers: a reply may be mebibytes long.
    let long = "x".repeat(3 * 8192);
    input.say(format!("{long}\n"));
    input.end();
    let mut line = String::new();
    std::io::BufReader::new(input).read_line(&mut line).unwrap();
    assert_eq!(line, format!("{long}\n"));
}

#[tokio::test]
async fn a_reply_is_read_on_its_own_thread_and_the_inputs_end_closes_the_delegate() {
    let (events, lines) = nothing_kept();
    let input = Replies::default();
    let d = Delegate::reading(
        {
            let read = input.clone();
            move || std::io::BufReader::new(read)
        },
        emit_into(&events),
        log_into(&lines),
    );
    let running = tokio::spawn({
        let d = d.clone();
        async move { d.run(&request("t1")).await }
    });
    let key = key_of(&events, 1).await;
    // Only now that the task is out does the input answer, naming that event's key.
    input.say(format!(
        "{}\n",
        json!({"key": key, "text": "```craft-answer\n{\"n\":1}\n```"})
    ));
    let reply = bounded(running).await.unwrap().unwrap();
    assert_eq!(reply.structured, Some(json!({"n": 1})));
    assert!(
        !d.0.closed.load(Ordering::SeqCst),
        "an input that is only quiet has not ended"
    );
    let waiting = tokio::spawn({
        let d = d.clone();
        async move { d.run(&request("t2")).await }
    });
    key_of(&events, 2).await;
    input.end();
    let ended = "its input to craft ended";
    let error = bounded(waiting).await.unwrap().unwrap_err();
    assert!(
        matches!(&error, AgentError::HostGone(why) if why == ended),
        "{error}"
    );
    let later = bounded(d.run(&request("t3"))).await.unwrap_err();
    assert!(
        matches!(&later, AgentError::HostGone(why) if why == ended),
        "{later}"
    );
    assert_eq!(
        events.lock().unwrap().len(),
        2,
        "the two tasks out, and no event once the input ended"
    );
    assert!(
        lines.lock().unwrap().is_empty(),
        "a good line and the end are passed over for nothing"
    );
}

/// Set when this test's binary runs again as a child: there the delegate reads that process's
/// stdin, as it does under `--delegate`; the parent answers through the other end of the pipe.
const READS_STDIN: &str = "CRAFT_TEST_DELEGATE_READS_STDIN";

/// The child's side: the delegate `--delegate` makes answers a task from this process's stdin,
/// says the key of each task it gives out, and fails the one waiting when that input ends.
fn reads_stdin() {
    fn said(key: u64) {
        // Straight out, past the test harness's own capture of `println!`, and on a line of its own: run with one
        // test thread, the harness prints `test <name> ... ` and no newline before the test, and the parent takes a
        // key only from the start of a line.
        std::io::stdout()
            .write_all(format!("\nKEY {key}\n").as_bytes())
            .unwrap();
    }
    let (events, lines) = nothing_kept();
    let d = Delegate::on_stdin(emit_into(&events), log_into(&lines));
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let running = tokio::spawn({
                let d = d.clone();
                async move { d.run(&request("t1")).await }
            });
            said(key_of(&events, 1).await);
            let reply = bounded(running).await.unwrap().unwrap();
            assert_eq!(reply.structured, Some(json!({"n": 1})));
            let waiting = tokio::spawn({
                let d = d.clone();
                async move { d.run(&request("t2")).await }
            });
            said(key_of(&events, 2).await);
            let error = bounded(waiting).await.unwrap().unwrap_err();
            assert!(
                matches!(&error, AgentError::HostGone(why) if why == "its input to craft ended"),
                "{error}"
            );
            assert!(
                lines.lock().unwrap().is_empty(),
                "a good line and the end are passed over for nothing"
            );
        });
}

#[test]
fn a_reply_on_this_process_stdin_is_read_and_its_end_closes_the_delegate() {
    if std::env::var_os(READS_STDIN).is_some() {
        reads_stdin();
        return;
    }
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["a_reply_on_this_process_stdin"])
        .env(READS_STDIN, "1")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut out = std::io::BufReader::new(child.stdout.take().unwrap());
    let (mut heard, mut line) = (String::new(), String::new());
    // The key of the task the child gave out last, once it has said it.
    let mut last_key = || {
        loop {
            line.clear();
            assert!(
                out.read_line(&mut line).unwrap() != 0,
                "the child ended before saying its key:\n{heard}"
            );
            heard.push_str(&line);
            if let Some(key) = line.trim().strip_prefix("KEY ") {
                return key.parse::<u64>().expect("the child says its task's key");
            }
        }
    };
    let mut into = child.stdin.take().unwrap();
    into.write_all(
        format!(
            "{}\n",
            json!({"key": last_key(), "text": "```craft-answer\n{\"n\":1}\n```"})
        )
        .as_bytes(),
    )
    .unwrap();
    // Only once the next task is out and waiting may the input end under it.
    last_key();
    drop(into);
    let mut rest = String::new();
    out.read_to_string(&mut rest).unwrap();
    let status = child.wait().unwrap();
    assert!(
        status.success(),
        "the child reading its stdin: {status}\n{heard}{rest}"
    );
}

#[test]
fn a_host_that_stopped_answering_stops_the_run_and_is_logged_as_a_stop() {
    let host = super::super::host::Host {
        kind: super::super::HostKind::OpenCode,
        models: super::super::models::ModelTable::default(),
        thinking: super::super::models::ThinkingTable::default(),
        command: "opencode".into(),
        agents: None,
        archived: true,
        delegate: None,
    };
    let gone = AgentError::HostGone("its input to craft ended".into());
    assert!(stops(&host, &gone));
    let outcome = outcome_of(&task("t", "t"), Err(gone), &host);
    assert_eq!(
        outcome.log_line().as_deref(),
        Some(
            "stopped — the process that runs the tasks stopped answering: its input to craft ended"
        )
    );
}
