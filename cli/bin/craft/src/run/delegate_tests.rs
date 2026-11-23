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

/// A delegate whose events are kept.
fn kept() -> (Delegate, Arc<Mutex<Vec<Event>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&events);
    (Delegate::new(move |e| seen.lock().unwrap().push(e)), events)
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
            prompt: "read p.md".into(),
        })
    );
    let text = "looked\n```craft-answer\n{\"findings\":[]}\n```\n";
    assert!(d.deliver(&json!({"key": key, "text": text}).to_string()));
    let reply = running.await.unwrap().unwrap();
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
    d.deliver(&json!({"key": key, "text": "I could not"}).to_string());
    assert!(matches!(
        running.await.unwrap(),
        Err(AgentError::NoAnswer { stdout, .. }) if stdout == "I could not"
    ));
    let failing = tokio::spawn({
        let d = d.clone();
        async move { d.run(&request("t2")).await }
    });
    let key = key_of(&events, 2).await;
    let said =
        "the child session failed (provider.usage-limit): You've hit your usage limit · resets 5pm";
    d.deliver(&json!({"key": key, "error": said}).to_string());
    let error = failing.await.unwrap().unwrap_err();
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
    assert!(!d.deliver("not json"));
    assert!(!d.deliver(r#"{"key":1}"#), "neither text nor error");
    assert!(!d.deliver(r#"{"key":99,"text":"x"}"#), "no such dispatch");
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
    assert!(!d.deliver(&json!({"key": key, "text": "late"}).to_string()));
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
    d.deliver(&json!({"key": two, "error": "second"}).to_string());
    d.deliver(&json!({"key": one, "error": "first"}).to_string());
    assert!(
        matches!(first.await.unwrap(), Err(AgentError::Failed { subtype }) if subtype == "first")
    );
    assert!(
        matches!(second.await.unwrap(), Err(AgentError::Failed { subtype }) if subtype == "second")
    );
}

#[tokio::test]
async fn once_the_input_closes_every_waiting_dispatch_fails() {
    let (d, events) = kept();
    let running = tokio::spawn({
        let d = d.clone();
        async move { d.run(&request("t1")).await }
    });
    key_of(&events, 1).await;
    d.close();
    let error = running.await.unwrap().unwrap_err();
    assert!(error.to_string().contains("closed its input"), "{error}");
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
fn delegate_is_opencode_s_with_the_event_stream_and_runs_no_opencode() {
    // An opencode that is not there: delegated, it is never asked which agents it has.
    let host = ready_of(
        &[
            "--backend",
            "opencode",
            "--delegate",
            "--host-bin",
            "/no/opencode",
        ],
        true,
    )
    .unwrap();
    assert!(host.delegate.is_some());
    assert_eq!(host.agents, None);
    let refused = "--delegate is opencode's alone, with --events json";
    assert_eq!(
        ready_of(&["--backend", "pi", "--delegate"], true).unwrap_err(),
        refused
    );
    assert_eq!(
        ready_of(&["--backend", "opencode", "--delegate"], false).unwrap_err(),
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
