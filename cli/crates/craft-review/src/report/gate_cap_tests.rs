//! A gate signal the review asked for and could not establish caps the verdict at Warning
//! (realm @nick/craft, node #487); a gate switched off on purpose does not.

use serde_json::{Value, json};

use super::{verdict, verdict_line};
use crate::gate::{Gate, Status, Track};
use crate::state::{RunState, STATE_VERSION};

const CI_GREEN: &str = "CI for def1234: clippy green (checks clippy) — informs only, not a pass";

/// A finished Rust run with `settled` findings and `gate` as its gate.
fn run(settled: &[Value], gate: Gate) -> RunState {
    let mut s: RunState = serde_json::from_value(json!({
        "version": STATE_VERSION,
        "context": {"repo": "/r", "base": "origin/main", "spec": "", "craftRoot": null, "craftVersion": null},
        "diff": {"base": "origin/main", "mergeBase": "abc", "head": "def", "dirty": false,
                 "files": ["src/lib.rs"], "stat": "", "log": ""},
        "tracks": [{"profile": "rust", "files": ["src/lib.rs"]}], "uncovered": [], "light": false,
        "phase": "done", "tasks": [],
        "rounds": {"round": 1, "pool": [], "yields": [], "expected": [], "returned": [], "failures": {}},
        "findings": [], "settled": settled, "notes": [], "notRun": []
    }))
    .unwrap();
    s.gate = gate;
    s
}

fn track(status: Status, provenance: &str) -> Track {
    Track {
        profile: "rust".into(),
        status,
        provenance: provenance.into(),
        ..Track::default()
    }
}

fn gated(t: Track) -> Gate {
    Gate {
        tracks: vec![t],
        ..Gate::default()
    }
}

fn confirmed(severity: &str) -> Value {
    json!({"severity": severity, "tier": "confirmed", "title": "t", "file": "src/lib.rs"})
}

#[test]
fn an_unknown_gate_with_nothing_found_is_a_warning_naming_the_gate_and_the_ci_it_saw() {
    let s = run(&[], gated(track(Status::Unknown, CI_GREEN)));
    let v = verdict(&s);
    assert_eq!(v, "Warning", "never Approve over an unknown gate");
    assert_eq!(
        verdict_line(&s, &v),
        format!("Warning — the gate was not established locally (rust: unknown); {CI_GREEN}")
    );
}

#[test]
fn an_unknown_gate_with_no_ci_read_says_no_ci_informed_it() {
    let s = run(
        &[],
        gated(track(
            Status::Unknown,
            "clippy: not run (cargo not installed)",
        )),
    );
    let v = verdict(&s);
    assert_eq!(v, "Warning");
    assert!(
        verdict_line(&s, &v).ends_with("(rust: unknown); no CI check informed it"),
        "{}",
        verdict_line(&s, &v)
    );
}

#[test]
fn findings_still_raise_an_unknown_gate_to_block_and_a_medium_stays_a_warning() {
    let high = run(
        &[confirmed("High")],
        gated(track(Status::Unknown, CI_GREEN)),
    );
    assert_eq!(verdict(&high), "Block");
    let medium = run(
        &[confirmed("Medium")],
        gated(track(Status::Unknown, CI_GREEN)),
    );
    assert_eq!(verdict(&medium), "Warning");
}

#[test]
fn a_gate_switched_off_or_a_refused_gate_from_keeps_its_approve() {
    let refused = Gate {
        skipped: "the launching run's gate in `/d` was not used: x".into(),
        ..Gate::default()
    };
    for gate in [Gate::not_asked(), refused] {
        let s = run(&[], gate.clone());
        let v = verdict(&s);
        assert_eq!(v, "Approve", "{gate:?}");
        assert_eq!(verdict_line(&s, &v), "Approve", "{gate:?}");
    }
}

#[test]
fn a_green_gate_approves_and_a_gate_taken_from_the_launcher_is_capped_the_same() {
    let s = run(&[], gated(track(Status::Pass, "clippy: clean")));
    assert_eq!(verdict(&s), "Approve");
    let taken = Gate {
        from: "/launcher/gate".into(),
        ..gated(track(Status::Unknown, CI_GREEN))
    };
    assert_eq!(verdict(&run(&[], taken)), "Warning");
}
