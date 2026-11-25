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
    wrote_on(HostKind::OpenCode, e)
}

fn wrote_on(kind: HostKind, e: AgentError) -> Option<String> {
    let o = quit_or(kind, e);
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

fn quit(stderr: &str, stdout: &str) -> AgentError {
    AgentError::Quit {
        code: Some(1),
        stderr: stderr.into(),
        stdout: stdout.into(),
    }
}

fn failed(subtype: &str) -> Option<String> {
    wrote(AgentError::Failed {
        subtype: subtype.into(),
    })
}

/// A failed exit's words are opencode's error events on stdout, else stderr's: never an event
/// stream, nor another host's reply (realm @nick/craft, node #666).
#[test]
fn a_failed_exit_wrote_its_error_not_its_stream_or_reply() {
    assert_eq!(
        wrote(quit("loading plugins", "Insufficient Balance")).as_deref(),
        Some("Insufficient Balance")
    );
    assert_eq!(wrote(quit("boom", "")).as_deref(), Some("boom"));
    // opencode with no error event: its stdout is the event stream, so stderr says why.
    assert_eq!(
        wrote(quit("killed: out of memory", "{\"type\":\"step_start\"}")).as_deref(),
        Some("killed: out of memory")
    );
    assert_eq!(wrote(quit("", "{\"type\":\"step_start\"}")), None);
    // An error event whose message is a JSON body is still the error.
    assert_eq!(
        wrote(quit(
            "loading plugins",
            "{\"error\":\"Insufficient Balance\"}"
        ))
        .as_deref(),
        Some("{\"error\":\"Insufficient Balance\"}")
    );
    // Another host's stdout is its reply, never why it failed.
    for kind in [HostKind::Codex, HostKind::Pi] {
        assert_eq!(
            wrote_on(kind, quit("rate limited", "Here is my review.")).as_deref(),
            Some("rate limited")
        );
        assert_eq!(wrote_on(kind, quit("", "Here is my review.")), None);
    }
    assert_eq!(wrote(quit("", "")), None);
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
