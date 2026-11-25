//! The memory over a plain list of findings: the scope check observed once, the marks in the
//! field the kind names, and the asks a kind wraps in its own tasks.

use std::cell::Cell;

use serde_json::{Value, json};

use super::super::{Memory, PriorDecision, RecordKind, Scope};

const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";

fn finding(title: &str) -> Value {
    json!({"severity": "Medium", "title": title, "file": "src/lib.rs", "line": 11, "why": "the detail", "memoryNote": ""})
}

fn record(kind: RecordKind, title: &str) -> PriorDecision {
    PriorDecision {
        id: format!("{kind:?}-a").to_lowercase(),
        kind,
        title: title.into(),
        scope: "src/lib.rs".into(),
        reason: "checked above".into(),
        who: "nick".into(),
        when: "2026-11-01".into(),
        commit: COMMIT.into(),
        line: 11,
        ..PriorDecision::default()
    }
}

fn memory(records: Vec<PriorDecision>) -> Memory {
    Memory {
        decisions: records,
        ..Memory::default()
    }
}

/// A scope check seeing every record it is handed unchanged, counting its calls.
fn unchanged(calls: &Cell<usize>) -> impl Fn(&[&PriorDecision]) -> Scope + '_ {
    move |ds| {
        calls.set(calls.get() + 1);
        Scope {
            unchanged: ds.iter().map(|d| d.id.clone()).collect(),
            ..Scope::default()
        }
    }
}

#[test]
fn a_sure_match_is_set_aside_its_mark_in_the_named_field_and_the_scope_checked_once() {
    let calls = Cell::new(0);
    let check = unchanged(&calls);
    let title = "unwrap on a checked value";
    let mut m = memory(vec![record(RecordKind::Decision, title)]);
    let findings = vec![finding(title)];
    let ask = m.match_ask(&findings, &[], &check).unwrap().unwrap();
    assert_eq!(
        (ask.id.as_str(), ask.label.as_str()),
        ("match-judge", "decision-match")
    );
    // A sure match the judge gave no verdict on still sets its finding aside.
    let out = m.decide(findings, (None, &[]), &check, "memoryNote");
    assert_eq!(calls.get(), 1, "decide reads the scope match_ask observed");
    assert_eq!(
        (out.kept.len(), out.set_aside.len(), out.reraised),
        (0, 1, 0)
    );
    let aside = &out.set_aside[0];
    assert!(
        aside["memoryNote"]
            .as_str()
            .unwrap()
            .starts_with(" · REJECTED BEFORE: checked above"),
        "{aside}"
    );
    assert_eq!(
        aside["why"], "the detail",
        "the judged rationale is untouched"
    );
}

#[test]
fn a_changed_scope_raises_the_finding_again_and_counts_it() {
    let title = "unwrap on a checked value";
    let mut m = memory(vec![record(RecordKind::Decision, title)]);
    let unseen = |_: &[&PriorDecision]| Scope::default();
    let out = m.decide(vec![finding(title)], (None, &[]), &unseen, "memoryNote");
    assert_eq!((out.kept.len(), out.reraised), (1, 1));
    assert!(
        out.kept[0]["memoryNote"]
            .as_str()
            .unwrap()
            .contains("raised again: the code in src/lib.rs changed"),
        "{}",
        out.kept[0]
    );
}

#[test]
fn a_finding_in_a_rules_scope_is_asked_about_and_covered_by_its_verdict() {
    let mut m = memory(vec![record(RecordKind::Rule, "unwraps are fine here")]);
    let findings = vec![finding("unwrap on input")];
    let asks = m.rule_asks(&findings, &[]).unwrap();
    assert_eq!(asks.len(), 1);
    assert_eq!(
        (asks[0].id.as_str(), asks[0].label.as_str()),
        ("rule-judge", "rule-match")
    );
    let answer = json!({"verdicts": [{"pair": 0, "covered": true, "violates": false, "why": "the rule's class"}]});
    let out = m.rule(findings, (&[Some(answer)], &[]), "memoryNote");
    assert_eq!((out.kept.len(), out.covered.len()), (0, 1));
    assert!(
        out.covered[0]["memoryNote"]
            .as_str()
            .unwrap()
            .contains("COVERED BY PROJECT RULE: unwraps are fine here"),
        "{}",
        out.covered[0]
    );
}

#[test]
fn with_no_rule_given_every_finding_is_kept_and_nothing_said() {
    let mut m = memory(vec![record(RecordKind::Decision, "something else")]);
    let findings = vec![finding("unwrap on input")];
    assert!(m.rule_asks(&findings, &[]).unwrap().is_empty());
    let out = m.rule(findings.clone(), (&[], &[]), "memoryNote");
    assert_eq!(out.kept, findings);
    assert!(out.notes.is_empty() && out.notices.is_empty());
}

#[test]
fn a_run_that_asked_no_recall_says_why_and_keeps_the_launchers_count() {
    let mut m = Memory::open(Some(Ok(
        json!([{"id": "decision-9999999999", "kind": "decision", "title": "t", "body": "b", "scope": ".", "status": "active"}]),
    )));
    m.not_recalled("not recalled — no gathered finding names a file");
    assert_eq!(
        m.source.why,
        "not recalled — no gathered finding names a file"
    );
    assert_eq!(
        (m.source.source.as_str(), m.source.passed),
        ("none", Some(1))
    );
}

#[test]
fn the_recall_ask_carries_no_repository_directive_and_its_cut() {
    let paths = vec!["src/lib.rs".to_owned()];
    let (ask, cut) = Memory::recall_ask(&paths, "v1").unwrap();
    assert_eq!(ask.id, "memory-recall");
    assert!(ask.prompt.contains("src/lib.rs"), "{}", ask.prompt);
    assert_eq!((cut.cut, cut.grouped), (0, 0));
    let review = Memory::recall_task("/repo", &paths, "v1").unwrap();
    assert!(review.prompt.ends_with(&ask.prompt));
    assert_ne!(review.prompt, ask.prompt, "the review adds its directive");
}
