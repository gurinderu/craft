use serde_json::{Value, json};

use super::{could_not, said};
use crate::hook::counts::tests::here;
use crate::hook::runs::{Found, LastRun, Scope};

const URL: &str = "https://github.com/o/r/pull/7";

fn human(v: &Value) -> &str {
    v["systemMessage"].as_str().unwrap()
}

fn model(v: &Value) -> &str {
    assert_eq!(
        v["hookSpecificOutput"]["hookEventName"],
        json!("PostToolUse")
    );
    v["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap()
}

#[test]
fn a_reviewed_head_says_nothing() {
    assert!(said(&Found::Reviewed, URL, &here()).is_none());
}

#[test]
fn a_missing_review_names_the_pr_its_head_and_the_last_run() {
    let mut h = here();
    h.head = "0123456789abcdef0123".into();
    let last = LastRun {
        ts: "2026-11-01T10-00-00Z".into(),
        head: "fedcba9876543210".into(),
        verdict: "⚠️ Warning".into(),
        scope: Scope::Delta,
    };
    let out = said(
        &Found::Missing {
            last: Some(last),
            malformed: 2,
        },
        URL,
        &h,
    )
    .unwrap();
    assert_eq!(
        human(&out),
        "craft: PR https://github.com/o/r/pull/7 was opened with no full craft review of its head 0123456789ab (last run: fedcba987654, ⚠️ Warning, delta, 2026-11-01 10:00:00 UTC)."
    );
    let m = model(&out);
    for part in [
        URL,
        "0123456789abcdef0123",
        "Tell the human",
        "craft:review",
        "craft review run --backend",
        "2 unreadable line(s)",
    ] {
        assert!(m.contains(part), "{part}: {m}");
    }
    let none = said(
        &Found::Missing {
            last: None,
            malformed: 0,
        },
        URL,
        &h,
    )
    .unwrap();
    assert!(
        human(&none).ends_with("(last run: none filed for feat/x)."),
        "{none}"
    );
    assert!(!model(&none).contains("unreadable"));
}

#[test]
fn a_store_that_cannot_be_read_is_could_not_check() {
    let out = said(
        &Found::NoStore("/s/index.jsonl: denied".into()),
        URL,
        &here(),
    )
    .unwrap();
    assert_eq!(
        human(&out),
        "craft: could not check PR https://github.com/o/r/pull/7 for a full craft review: the run store is not readable (/s/index.jsonl: denied)."
    );
    let bare = could_not(None, "the hook input is not JSON");
    assert_eq!(
        human(&bare),
        "craft: could not check the opened PR for a full craft review: the hook input is not JSON."
    );
    assert!(model(&bare).contains("Tell the human"));
}
