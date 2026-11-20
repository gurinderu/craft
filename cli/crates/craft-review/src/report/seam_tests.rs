//! The Consumers section names the CONSUMERS lines only the seam pass read — no confined lens was
//! shown them, so none marked them per line — only when a seam pass answered; else those lines
//! are unmarked, with why. It names apart the lines shown only to lenses that did not answer.

use serde_json::{Value, json};

use super::{degraded_notes, markdown};
use crate::state::{RunState, STATE_VERSION};

const SEAM_RAN: &str = "- 1 line(s) handed to the seam pass, not marked per line: tools/z.rs:3\n";
const SEAM_DID_NOT_RUN: &str =
    "- 1 line(s) no lens marked, the seam pass did not run: tools/z.rs:3\n";

/// A finished unit-mode run (`units` the touched units, none: the mode off; `seam` the seam
/// pass's outcome, `null`: none answered) whose list names `src/a/x.rs:1`, shown to a lens, and
/// `tools/z.rs:3`, shown to none.
fn state(units: &[&str], seam: &Value) -> RunState {
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
        "units": {"asked": true, "tracks": [{"profile": "rust", "slices": [], "units": units, "seam": seam}]},
        "findings": [], "settled": [], "notes": [], "notRun": []
    }))
    .unwrap()
}

/// A report line as a degraded note words it.
fn note(line: &str) -> String {
    line.trim_start_matches("- ").trim_end().to_owned()
}

fn answered() -> Value {
    json!({"findings": 0, "answered": 0, "dispositions": {"confirm": 0, "drop": 0, "convert": 0}, "setAside": []})
}

#[test]
fn a_line_only_the_seam_pass_read_is_named_as_not_marked_per_line() {
    let report = markdown(&state(&["src/a"], &answered()), "Approve");
    assert!(report.contains(SEAM_RAN), "{report}");
    assert!(!report.contains("seam pass did not run"), "{report}");
}

#[test]
fn without_a_seam_pass_no_line_is_said_to_be_handed_to_it() {
    let report = markdown(&state(&[], &Value::Null), "Approve");
    assert!(!report.contains("seam pass"), "{report}");
}

#[test]
fn a_line_left_to_a_seam_pass_that_never_answered_is_unmarked_and_says_why() {
    let s = state(&["src/a"], &Value::Null);
    let report = markdown(&s, "Approve");
    assert!(report.contains(SEAM_DID_NOT_RUN), "{report}");
    assert!(!report.contains("handed to the seam pass"), "{report}");
    let notes = degraded_notes(&s);
    assert!(notes.contains(&note(SEAM_DID_NOT_RUN)), "{notes:?}");
}

/// `state` with a second unit track of `profile` whose seam pass did not answer.
fn with_dead_seam(mut s: RunState, profile: &str) -> RunState {
    let mut other = s.units.tracks[0].clone();
    other.profile = profile.into();
    other.seam = None;
    s.units.tracks.push(other);
    s
}

#[test]
fn only_the_lines_own_track_s_seam_pass_counts() {
    let s = with_dead_seam(state(&["src/a"], &answered()), "nix");
    let report = markdown(&s, "Approve");
    assert!(report.contains(SEAM_RAN), "{report}");
    assert!(!report.contains("seam pass did not run"), "{report}");
    assert!(degraded_notes(&s).is_empty(), "{:?}", degraded_notes(&s));
    // The other way round: the nix track's seam pass answered, the rust one's did not.
    let mut s = with_dead_seam(state(&["src/a"], &answered()), "rust");
    s.units.tracks[0].profile = "nix".into();
    let report = markdown(&s, "Approve");
    assert!(report.contains(SEAM_DID_NOT_RUN), "{report}");
}

#[test]
fn a_line_shown_only_to_lenses_that_did_not_answer_is_named_apart() {
    let mut s = state(&[], &Value::Null);
    s.rounds.consumers_shown.push("tools/z.rs:3".into());
    s.rounds.consumers_unanswered.push("tools/z.rs:3".into());
    let line = "- 1 line(s) shown only to lenses that did not answer: tools/z.rs:3\n";
    let report = markdown(&s, "Approve");
    assert!(report.contains(line), "{report}");
    assert!(
        degraded_notes(&s).contains(&note(line)),
        "{:?}",
        degraded_notes(&s)
    );
}

#[test]
fn a_gate_whose_changed_lines_could_not_be_read_is_a_degraded_note() {
    let mut s = state(&[], &Value::Null);
    s.gate.unread_lines = "git printed non-UTF-8 output".into();
    let notes = degraded_notes(&s);
    assert!(
        notes.iter().any(|n| n.starts_with(
            "the gate could not read the change's lines (git printed non-UTF-8 output)"
        )),
        "{notes:?}"
    );
}
