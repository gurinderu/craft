use serde_json::Value;

use super::{said, when};
use crate::hook::runs::{Found, Here, LastRun, Scope};

fn here(branch: Option<&str>) -> Here {
    Here {
        project: "/p".into(),
        head: "0123456789abcdef0123456789abcdef01234567".into(),
        branch: branch.map(Into::into),
    }
}

fn texts(v: &Value) -> (String, String) {
    let human = v["systemMessage"].as_str().unwrap().to_owned();
    assert_eq!(v["hookSpecificOutput"]["hookEventName"], "PreToolUse");
    let model = v["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap()
        .to_owned();
    (human, model)
}

#[test]
fn a_reviewed_head_says_nothing() {
    assert!(said(&Found::Reviewed, &here(Some("b"))).is_none());
}

#[test]
fn a_missing_review_names_the_head_the_last_run_and_how_to_run_one() {
    let last = LastRun {
        ts: "2026-11-02T10-05-09Z".into(),
        head: "fedcba9876543210fedcba9876543210fedcba98".into(),
        verdict: "Block".into(),
        scope: Scope::Delta,
    };
    let found = Found::Missing {
        last: Some(last),
        malformed: 2,
    };
    let (human, model) = texts(&said(&found, &here(Some("feat/x"))).unwrap());
    for text in [&human, &model] {
        assert!(text.contains("no full craft review on this head"), "{text}");
        assert!(text.contains("0123456789ab"), "{text}");
        assert!(
            text.contains("fedcba987654, Block, delta, 2026-11-02 10:05:09 UTC"),
            "{text}"
        );
    }
    for text in [&human, &model] {
        assert!(text.contains("craft:review or craft:rust-audit"), "{text}");
    }
    assert!(model.contains("craft review run"), "{model}");
    assert!(model.contains("2 unreadable"), "{model}");
}

#[test]
fn a_branch_with_no_run_says_so() {
    let found = Found::Missing {
        last: None,
        malformed: 0,
    };
    let (human, _) = texts(&said(&found, &here(Some("feat/x"))).unwrap());
    assert!(
        human.contains("no craft review is filed for feat/x"),
        "{human}"
    );
    let (human, _) = texts(&said(&found, &here(None)).unwrap());
    assert!(human.contains("detached"), "{human}");
}

#[test]
fn an_unreadable_store_is_said_not_kept_silent() {
    let found = Found::NoStore("/s/index.jsonl: No such file".into());
    let (human, model) = texts(&said(&found, &here(Some("b"))).unwrap());
    for text in [&human, &model] {
        assert!(text.contains("could not check"), "{text}");
        assert!(text.contains("/s/index.jsonl: No such file"), "{text}");
    }
}

#[test]
fn a_timestamp_reads_as_a_utc_time() {
    assert_eq!(when("2026-11-02T10-05-09Z"), "2026-11-02 10:05:09 UTC");
    assert_eq!(when("odd"), "odd");
}
