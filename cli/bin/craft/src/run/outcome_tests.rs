use std::path::PathBuf;

use super::*;
use crate::run::HostKind;
use crate::run::models::thinking_table;

fn host(kind: HostKind) -> Host {
    Host {
        kind,
        models: std::iter::empty().collect(),
        thinking: thinking_table("", "--thinking").unwrap(),
        command: PathBuf::from("x"),
        agents: None,
        archived: true,
        delegate: None,
    }
}

fn wrote(e: AgentError) -> Option<String> {
    let o = quit_or(HostKind::OpenCode, e);
    let Outcome::Unanswered { wrote, .. } = o else {
        panic!("{o:?}")
    };
    wrote
}

fn quit_or(kind: HostKind, e: AgentError) -> Outcome {
    let task = Task {
        id: "t".into(),
        label: "t".into(),
        model: "opus".into(),
        prompt_file: PathBuf::from("/p"),
        schema_file: PathBuf::from("/s"),
        answer_file: PathBuf::from("/a"),
        agent_type: None,
        consumer_agent: None,
        kind: None,
    };
    outcome_of(&task, Err(e), &host(kind))
}

fn quit(stderr: &str, stdout: &str, errors: &[&str]) -> AgentError {
    AgentError::Quit {
        code: Some(1),
        stderr: stderr.into(),
        stdout: stdout.into(),
        errors: errors.iter().map(|&e| e.to_owned()).collect(),
    }
}

fn failed(subtype: &str) -> Option<String> {
    wrote(AgentError::Failed {
        subtype: subtype.into(),
    })
}

/// A failed exit's words are its last error event's, as the backend read them, else stderr's:
/// never its stdout, an event stream or a reply (realm @nick/craft, node #666).
#[test]
fn a_failed_exit_wrote_its_error_not_its_stream_or_reply() {
    let events = "{\"type\":\"step_start\"}";
    assert_eq!(
        wrote(quit(
            "loading plugins",
            "Insufficient Balance",
            &["Insufficient Balance"]
        ))
        .as_deref(),
        Some("Insufficient Balance")
    );
    // A provider's raw error body opens as an event does, and is still the error.
    let body = "{\"type\":\"error\",\"error\":{\"message\":\"overloaded\"}}";
    assert_eq!(
        wrote(quit("loading plugins", body, &[body])).as_deref(),
        Some(body)
    );
    assert_eq!(
        wrote(quit("", "x", &["first", "APIError:\n  upstream refused"])).as_deref(),
        Some("APIError: upstream refused")
    );
    assert_eq!(
        wrote(quit("killed: out of memory", events, &[])).as_deref(),
        Some("killed: out of memory")
    );
    assert_eq!(wrote(quit("", events, &[])), None);
    assert_eq!(
        wrote(quit("rate limited", "Here is my review.", &[])).as_deref(),
        Some("rate limited")
    );
    assert_eq!(wrote(quit("", "Here is my review.", &[])), None);
    let long = "e".repeat(400);
    assert_eq!(
        wrote(quit("", "", &[&long])).map(|l| l.chars().count()),
        Some(300)
    );
}

/// A clean exit with no answer is read by stderr alone, a failed one by its stderr; craft's own
/// errors say nothing (realm @nick/craft, node #666).
#[test]
fn a_dead_agent_wrote_only_its_own_words() {
    let no_answer = |stderr: &str| AgentError::NoAnswer {
        stderr: stderr.into(),
        stdout: "Here is my review in prose.".into(),
    };
    assert_eq!(wrote(no_answer("")), None);
    assert_eq!(
        wrote(no_answer("overloaded")).as_deref(),
        Some("overloaded")
    );
    assert_eq!(
        wrote(AgentError::Exit {
            code: Some(2),
            stderr: "segfault".into()
        })
        .as_deref(),
        Some("segfault")
    );
    assert_eq!(wrote(AgentError::NotAnObject), None);
}

/// A delegated task's failure is the runtime's error, the retry's when the plugin tried once more
/// alone; the plugin's and the binary's own words are none of the agent's (realm @nick/craft, node
/// #666).
#[test]
fn a_delegated_failure_is_read_by_the_runtime_error_alone() {
    assert_eq!(
        failed("the child session failed (provider.no-route): no route").as_deref(),
        Some("provider.no-route: no route")
    );
    assert_eq!(
        failed("the child session failed (provider.no-route)").as_deref(),
        Some("provider.no-route")
    );
    assert_eq!(
        failed("the child session failed (unknown): Insufficient Balance").as_deref(),
        Some("Insufficient Balance")
    );
    assert_eq!(
        failed("the child session failed (api.error): upstream refused\n  retry later").as_deref(),
        Some("api.error: upstream refused retry later")
    );
    assert_eq!(
        failed(
            "the child session was stopped at its deadline (tried once more alone: the child session failed (provider.no-route): no route)"
        )
        .as_deref(),
        Some("provider.no-route: no route")
    );
    let retried = |second: &str| failed(&format!("broke (tried once more alone: {second})"));
    assert_eq!(
        retried("the child session failed (x)").as_deref(),
        Some("x")
    );
    assert_eq!(
        retried("the child session failed (x): bad (400)").as_deref(),
        Some("x: bad (400)")
    );
    // The plugin's and the binary's own words are none of the agent's.
    for own in [
        "the child session failed (outcome interrupted): the agent loop ended without succeeding",
        "the child session failed (unknown)",
        "the child session was stopped at its deadline",
        "its reply could not be read: it is not UTF-8",
    ] {
        assert_eq!(failed(own), None, "{own}");
    }
}
