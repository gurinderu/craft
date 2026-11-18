use serde_json::Value;

use super::{could_not, moved, said, when};
use crate::hook::here::Here;
use crate::hook::runs::{Found, LastRun, Scope};

fn here(branch: Option<&str>) -> Here {
    Here {
        project: "/p".into(),
        head: "0123456789abcdef0123456789abcdef01234567".into(),
        branch: branch.map(Into::into),
        named: None,
        trunk: "origin/main".into(),
        point: "p".into(),
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

fn missing(last: Option<LastRun>, crates_only: bool, malformed: usize) -> Found {
    Found::Missing {
        last,
        crates_only,
        malformed,
    }
}

#[test]
fn a_reviewed_head_says_nothing() {
    assert!(said(&Found::Reviewed, &here(Some("b"))).is_none());
}

#[test]
fn the_human_is_warned_before_and_the_model_told_the_pr_was_opened() {
    let last = LastRun {
        ts: "2026-11-02T10-05-09Z".into(),
        head: "fedcba9876543210fedcba9876543210fedcba98".into(),
        verdict: "Block".into(),
        scope: Scope::Delta,
    };
    let (human, model) =
        texts(&said(&missing(Some(last), false, 2), &here(Some("feat/x"))).unwrap());
    assert!(
        human.starts_with(
            "craft: opening a PR with no full craft review on this head (0123456789ab)"
        ),
        "{human}"
    );
    assert!(
        model.starts_with("craft: the pull request was opened without a full craft review of its head (0123456789ab)"),
        "{model}"
    );
    assert!(
        model.contains("tell the human") || model.contains("Tell the human"),
        "{model}"
    );
    assert!(model.contains("offer to run one"), "{model}");
    for text in [&human, &model] {
        assert!(
            text.contains("fedcba987654, Block, delta, 2026-11-02 10:05:09 UTC"),
            "{text}"
        );
        assert!(!text.contains("rust-audit covered only"), "{text}");
    }
    assert!(model.contains("craft review run"), "{model}");
    assert!(model.contains("2 unreadable"), "{model}");
}

#[test]
fn every_scope_and_an_empty_verdict_of_the_last_run_are_named() {
    for (scope, verdict, says) in [
        (Scope::Full, "Approve", "Approve, full"),
        (Scope::Unknown, "Warning", "Warning, scope unknown"),
        (Scope::Delta, "", "no verdict, delta"),
    ] {
        let last = LastRun {
            ts: "t".into(),
            head: "h".into(),
            verdict: verdict.into(),
            scope,
        };
        let (human, _) = texts(&said(&missing(Some(last), false, 0), &here(Some("b"))).unwrap());
        assert!(human.contains(says), "{human}");
    }
}

#[test]
fn a_rust_audit_of_the_crates_only_is_named() {
    let (human, model) = texts(&said(&missing(None, true, 0), &here(Some("b"))).unwrap());
    for text in [&human, &model] {
        assert!(
            text.contains(
                "A rust-audit covered only the crates; the rest of the change has no full review."
            ),
            "{text}"
        );
    }
}

#[test]
fn a_branch_with_no_run_says_so_and_a_named_head_is_named() {
    let found = missing(None, false, 0);
    let (human, _) = texts(&said(&found, &here(Some("feat/x"))).unwrap());
    assert!(
        human.contains("no craft review is filed for feat/x"),
        "{human}"
    );
    let (human, _) = texts(&said(&found, &here(None)).unwrap());
    assert!(human.contains("detached"), "{human}");
    let mut named = here(Some("feat/y"));
    named.named = Some("feat/y".into());
    let (human, _) = texts(&said(&found, &named).unwrap());
    assert!(
        human.contains("0123456789ab, the tip of feat/y that --head names"),
        "{human}"
    );
}

#[test]
fn an_unreadable_store_and_every_other_doubt_are_said_not_kept_silent() {
    let found = Found::NoStore("/s/index.jsonl: Is a directory".into());
    let (human, model) = texts(&said(&found, &here(Some("b"))).unwrap());
    for text in [&human, &model] {
        assert!(text.contains("could not"), "{text}");
        assert!(text.contains("/s/index.jsonl: Is a directory"), "{text}");
    }
    let (human, model) = texts(&could_not("git cannot read HEAD"));
    assert!(human.starts_with("craft: could not check"), "{human}");
    assert!(model.contains("git cannot read HEAD"), "{model}");
    let (human, model) = texts(&moved("git commit"));
    assert!(
        human.contains("could not check before the PR: the command changes the branch first (`git commit`) — run the review on the final head"),
        "{human}"
    );
    assert!(model.contains("offer to run one"), "{model}");
}

#[test]
fn a_timestamp_reads_as_a_utc_time() {
    assert_eq!(when("2026-11-02T10-05-09Z"), "2026-11-02 10:05:09 UTC");
    assert_eq!(when("odd"), "odd");
}
