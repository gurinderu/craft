//! A metrics-only lens that never returned caps an otherwise clean verdict at Warning; findings
//! still raise the verdict past it, what did not run still makes it INCOMPLETE, and the gap is
//! named under "Not run" whatever the verdict.

use serde_json::{Value, json};

use super::{markdown, not_run, verdict, verdict_line};
use crate::state::{RunState, STATE_VERSION};

const GAP: &str = "general metrics-only lenses that never returned — complexity: died";

/// A finished full run with `settled` findings, no gate asked, the complexity lens a gap and
/// `missing` what else did not run.
fn run(settled: &[Value], missing: &[&str]) -> RunState {
    let mut s: RunState = serde_json::from_value(json!({
        "version": STATE_VERSION,
        "context": {"repo": "/r", "base": "origin/main", "spec": "", "craftRoot": null, "craftVersion": null},
        "diff": {"base": "origin/main", "mergeBase": "abc", "head": "def", "dirty": false,
                 "files": ["web/app.ts"], "stat": "", "log": ""},
        "tracks": [{"profile": "general", "files": ["web/app.ts"]}], "uncovered": [], "light": false,
        "phase": "done", "tasks": [],
        "rounds": {"round": 1, "pool": [], "yields": [], "expected": [], "returned": [], "failures": {}},
        "findings": [], "settled": settled, "notes": [], "notRun": missing, "capped": [GAP]
    }))
    .unwrap();
    s.gate = crate::gate::Gate::not_asked();
    s
}

fn confirmed(severity: &str) -> Value {
    json!({"severity": severity, "tier": "confirmed", "title": "t", "file": "web/app.ts"})
}

#[test]
fn a_gap_alone_holds_approve_at_warning_and_says_why() {
    let s = run(&[], &[]);
    let v = verdict(&s);
    assert_eq!(v, "Warning");
    let line = verdict_line(&s, &v);
    assert!(
        line.contains("a coverage gap holds it at Warning") && line.contains(GAP),
        "{line}"
    );
}

#[test]
fn a_confirmed_finding_still_raises_the_verdict_and_the_gap_is_still_named() {
    for (severity, want) in [
        ("High", "Block"),
        ("Critical", "Block"),
        ("Medium", "Warning"),
    ] {
        let s = run(&[confirmed(severity)], &[]);
        let v = verdict(&s);
        assert_eq!(v, want, "{severity}");
        let line = verdict_line(&s, &v);
        assert!(
            !line.contains("coverage gap holds it"),
            "a finding's verdict is no cap: {line}"
        );
        assert!(not_run(&s).iter().any(|n| n.contains(GAP)), "{severity}");
        let report = markdown(&s, &v);
        let after = &report[report.find("## Not run").unwrap()..];
        assert!(
            after.contains(GAP) && after.contains("a coverage gap"),
            "{report}"
        );
    }
}

#[test]
fn what_did_not_run_makes_it_incomplete_and_the_gap_stays_named() {
    let s = run(&[], &["rust lenses that never returned — errors: died"]);
    let v = verdict(&s);
    assert_eq!(
        v, "INCOMPLETE",
        "the cap does not turn it into Warning (INCOMPLETE)"
    );
    assert!(!verdict_line(&s, &v).contains("coverage gap holds it"));
    let named = not_run(&s);
    assert_eq!(named.len(), 2, "{named:?}");
    assert!(
        named[0].contains("errors") && named[1].contains(GAP),
        "{named:?}"
    );
    let s = run(&[confirmed("Medium")], &["x"]);
    assert_eq!(verdict(&s), "Warning (INCOMPLETE)");
}
