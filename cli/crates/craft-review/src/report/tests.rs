use serde_json::json;

use super::{markdown, verdict, verdict_line};
use crate::state::{RunState, STATE_VERSION};

/// A finished run's state over `tracks` with `uncovered` left out and nothing found.
fn state(tracks: &serde_json::Value, uncovered: &[&str]) -> RunState {
    serde_json::from_value(json!({
        "version": STATE_VERSION,
        "context": {"repo": "/r", "base": "origin/main", "spec": "", "craftRoot": null, "craftVersion": null},
        "diff": {"base": "origin/main", "mergeBase": "abc", "head": "def", "dirty": false,
                 "files": ["src/lib.rs", "a.nix", "app.py", "Makefile"], "stat": "", "log": ""},
        "tracks": tracks, "uncovered": uncovered, "light": false, "phase": "done", "tasks": [],
        "rounds": {"round": 1, "pool": [], "yields": [], "expected": [], "returned": [], "failures": {}},
        "findings": [], "settled": [], "notes": [], "notRun": []
    }))
    .unwrap()
}

fn plan(lenses: &[&str]) -> serde_json::Value {
    json!({"sizeBucket": "small", "lenses": lenses, "maxRounds": 1, "verifyVotes": 1, "isLibrary": false,
           "securitySensitive": false, "intent": "", "spec": "", "churn": [], "repoRules": [],
           "surfaceDropped": [], "lightSkipped": []})
}

#[test]
fn each_profile_is_counted_and_planned_under_its_own_name() {
    let s = state(
        &json!([
            {"profile": "rust", "files": ["src/lib.rs"], "plan": plan(&["errors"]), "rounds": 1, "dry": true},
            {"profile": "nix", "files": ["a.nix"], "plan": plan(&["intent"]), "rounds": 1, "dry": true},
            {"profile": "general", "files": ["app.py"], "plan": plan(&["correctness"]), "rounds": 1, "dry": true},
        ]),
        &["Makefile"],
    );
    let v = verdict(&s);
    assert_eq!(v, "Approve", "configuration alone is no hole");
    let report = markdown(&s, &v);
    for want in [
        "4 changed file(s), 1 Rust, 1 Nix, 1 source.",
        "Plan (rust): small diff, full review, at most 1 round(s). Lenses planned: errors; ran: none.",
        "Plan (nix): small diff",
        "Plan (general): small diff",
        "## Not reviewed (no language profile)\n\n- Makefile\n",
    ] {
        assert!(report.contains(want), "{want}: {report}");
    }
}

#[test]
fn code_no_profile_took_still_marks_the_verdict_partial_coverage() {
    let s = state(
        &json!([{"profile": "rust", "files": ["src/lib.rs"], "plan": plan(&["errors"])}]),
        &["app.py", "Makefile"],
    );
    let v = verdict(&s);
    assert_eq!(v, "Approve (PARTIAL COVERAGE)");
    assert_eq!(
        verdict_line(&s, &v),
        "Approve (PARTIAL COVERAGE) — 1 changed file(s) matched no language profile and were NOT reviewed (app.py): this verdict covers only the files its language profiles reviewed"
    );
    assert!(
        markdown(&s, &v).contains("Plan: small diff"),
        "one profile, no name"
    );
}
