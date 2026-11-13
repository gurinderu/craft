//! A reduced round — a delta round over the fix commits only, or a light pass — never approves:
//! Approve comes only from a full round; findings still raise its verdict as ever.

use serde_json::{Value, json};

use super::{verdict, verdict_line};
use crate::prompts::ReScope;
use crate::state::{RunState, STATE_VERSION};

/// A finished Rust run with `settled` findings, no gate asked, `light` and `scope` as given.
fn run(settled: &[Value], light: bool, scope: ReScope) -> RunState {
    let mut s: RunState = serde_json::from_value(json!({
        "version": STATE_VERSION,
        "context": {"repo": "/r", "base": "origin/main", "spec": "", "craftRoot": null, "craftVersion": null},
        "diff": {"base": "origin/main", "mergeBase": "abc", "head": "def", "dirty": false,
                 "files": ["src/lib.rs"], "stat": "", "log": ""},
        "tracks": [{"profile": "rust", "files": ["src/lib.rs"]}], "uncovered": [], "light": light,
        "phase": "done", "tasks": [],
        "rounds": {"round": 1, "pool": [], "yields": [], "expected": [], "returned": [], "failures": {}},
        "findings": [], "settled": settled, "notes": [], "notRun": []
    }))
    .unwrap();
    s.gate = crate::gate::Gate::not_asked();
    s.context.re_review = scope;
    s
}

fn confirmed(severity: &str) -> Value {
    json!({"severity": severity, "tier": "confirmed", "title": "t", "file": "src/lib.rs"})
}

#[test]
fn a_clean_delta_round_is_a_warning_that_says_why() {
    let s = run(&[], false, ReScope::Fixes);
    let v = verdict(&s);
    assert_eq!(v, "Warning", "a delta round never approves");
    let line = verdict_line(&s, &v);
    assert!(
        line.starts_with("Warning — ") && line.contains("Approve comes only from a full round"),
        "{line}"
    );
}

#[test]
fn a_clean_light_pass_is_a_warning() {
    let s = run(&[], true, ReScope::First);
    let v = verdict(&s);
    assert_eq!(v, "Warning");
    assert!(
        verdict_line(&s, &v).contains("Approve comes only from a full round"),
        "{}",
        verdict_line(&s, &v)
    );
}

#[test]
fn a_full_round_still_approves() {
    for scope in [ReScope::First, ReScope::Rescan] {
        let s = run(&[], false, scope);
        let v = verdict(&s);
        assert_eq!(v, "Approve", "{scope:?}");
        assert_eq!(verdict_line(&s, &v), "Approve", "{scope:?}");
    }
}

#[test]
fn findings_still_raise_a_delta_round_and_its_cap_note_is_absent() {
    let high = run(&[confirmed("High")], false, ReScope::Fixes);
    assert_eq!(verdict(&high), "Block");
    let medium = run(&[confirmed("Medium")], false, ReScope::Fixes);
    let v = verdict(&medium);
    assert_eq!(v, "Warning");
    assert!(
        !verdict_line(&medium, &v).contains("Approve comes only from a full round"),
        "a Warning a finding earned is not a cap"
    );
}
