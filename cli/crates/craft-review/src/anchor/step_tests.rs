//! The step over a run: the move kept with where it came from, a dirty tree, and what the verifier
//! and the report read (realm @nick/craft, node #547).

use serde_json::{Value, json};

use super::super::{FIELD, moved_from, reanchor_with};
use super::{Fake, ROOT, finding};
use crate::state::{RunState, STATE_VERSION};

fn run(findings: &[Value]) -> RunState {
    serde_json::from_value(json!({
        "version": STATE_VERSION,
        "context": {"repo": ROOT, "base": "origin/main", "spec": "", "craftRoot": null, "craftVersion": null},
        "diff": {"base": "origin/main", "mergeBase": "abc", "head": "def", "dirty": false,
                 "files": ["src/lib.rs"], "stat": "", "log": ""},
        "tracks": [{"profile": "rust", "files": ["src/lib.rs"]}], "uncovered": [], "light": false,
        "phase": "verify", "tasks": [],
        "rounds": {"round": 1, "pool": [], "yields": [], "expected": [], "returned": [], "failures": {}},
        "findings": findings, "settled": [], "notes": [], "notRun": []
    }))
    .unwrap()
}

#[test]
fn the_step_moves_the_line_keeps_where_it_came_from_and_names_it_in_one_note() {
    let mut r = run(&[
        finding(603, "head_lines", &json!({})),
        finding(4, "head_lines", &json!({})),
    ]);
    let notes = reanchor_with(&mut r, &Fake::default());
    assert_eq!(r.findings[0]["line"], 2);
    assert_eq!(moved_from(&r.findings[0]), Some(603));
    assert_eq!(r.findings[1]["line"], 4);
    assert_eq!(r.findings[1].get(FIELD), None);
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert!(notes[0].starts_with("1 finding(s) moved"), "{}", notes[0]);
    assert!(
        notes[0].contains("`src/lib.rs:603` → line 2"),
        "{}",
        notes[0]
    );
    // Run again, as the critic's verification pass does: nothing moves twice.
    assert!(reanchor_with(&mut r, &Fake::default()).is_empty());
    assert_eq!(moved_from(&r.findings[0]), Some(603));
}

#[test]
fn a_dirty_tree_is_not_read_and_says_so() {
    let mut r = run(&[finding(603, "head_lines", &json!({}))]);
    r.diff.dirty = true;
    let notes = super::super::reanchor(&mut r);
    assert_eq!(r.findings[0]["line"], 603);
    assert!(notes[0].contains("did not run"), "{notes:?}");
}

#[test]
fn the_verifier_and_the_report_read_the_corrected_line() {
    let mut r = run(&[finding(603, "head_lines", &json!({"severity": "High"}))]);
    reanchor_with(&mut r, &Fake::default());
    let tasks = crate::verify::tasks(&r).unwrap();
    assert!(
        tasks.iter().all(|t| t.label.contains("src/lib.rs:2")),
        "{:?}",
        tasks.iter().map(|t| &t.label).collect::<Vec<_>>()
    );
    crate::verify::settle_run(&mut r);
    let md = crate::report::markdown(&r, &crate::report::verdict(&r));
    assert!(
        md.contains("`src/lib.rs:2` (line corrected from 603)"),
        "{md}"
    );
}
