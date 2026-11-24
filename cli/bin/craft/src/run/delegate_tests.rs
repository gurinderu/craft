use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use craft_agent::{AgentBackend, AgentError, AgentRequest};
use serde_json::json;

use super::super::events::Event;
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
    assert!(error.to_string().contains("closed its input"), "{error}");
    let later = bounded(d.run(&request("t2"))).await.unwrap_err();
    assert!(later.to_string().contains("closed its input"), "{later}");
    assert_eq!(
        events.lock().unwrap().len(),
        1,
        "a dispatch after the close sends no event"
    );
}

#[tokio::test]
async fn a_task_event_that_could_not_be_written_fails_its_dispatch_at_once() {
    let (d, _, _) = kept_logged(false);
    let error = bounded(d.run(&request("t1"))).await.unwrap_err();
    assert!(
        error.to_string().contains("could not be handed to"),
        "{error}"
    );
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
    let sink = super::super::events::Sink { json };
    super::super::ready(&cli.run, std::path::Path::new("/nowhere"), sink).map(|(_, host, _)| host)
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
