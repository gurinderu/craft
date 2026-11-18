//! The Consumers section names the CONSUMERS lines only the seam pass read: no confined lens was
//! shown them, so none marked them per line.

use serde_json::json;

use super::markdown;
use crate::state::{RunState, STATE_VERSION};

/// A finished unit-mode run (`units` the touched units, none: the mode off) whose list names
/// `src/a/x.rs:1`, shown to a lens, and `tools/z.rs:3`, shown to none.
fn state(units: &[&str]) -> RunState {
    let site = |file: &str, line: u32| json!({"file": file, "line": line, "text": "t", "from": ["name search"]});
    serde_json::from_value(json!({
        "version": STATE_VERSION,
        "context": {"repo": "/r", "base": "origin/main", "spec": "", "craftRoot": null, "craftVersion": null,
                    "consumers": {"sources": ["name search"], "symbols": [{"name": "rule", "file": "src/a/lib.rs", "line": 1,
                                  "sites": [site("src/a/x.rs", 1), site("tools/z.rs", 3)]}]}},
        "diff": {"base": "origin/main", "mergeBase": "abc", "head": "def", "dirty": false,
                 "files": ["src/a/lib.rs"], "stat": "", "log": ""},
        "tracks": [], "light": false, "phase": "done", "tasks": [],
        "rounds": {"round": 1, "pool": [], "yields": [], "expected": [], "returned": [], "failures": {},
                   "consumersMarked": ["src/a/x.rs:1"], "consumersShown": ["src/a/x.rs:1"]},
        "units": {"asked": true, "tracks": [{"profile": "rust", "slices": [], "units": units}]},
        "findings": [], "settled": [], "notes": [], "notRun": []
    }))
    .unwrap()
}

#[test]
fn a_line_only_the_seam_pass_read_is_named_as_not_marked_per_line() {
    let report = markdown(&state(&["src/a"]), "Approve");
    assert!(
        report.contains("- 1 line(s) handed to the seam pass, not marked per line: tools/z.rs:3\n"),
        "{report}"
    );
}

#[test]
fn without_a_seam_pass_no_line_is_said_to_be_handed_to_it() {
    let report = markdown(&state(&[]), "Approve");
    assert!(!report.contains("handed to the seam pass"), "{report}");
}
