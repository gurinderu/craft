//! The degraded notes of a round its host ended without a submit — a stopping signal cut it short
//! — kept in the run's directory beside the answers that landed: the resume takes them, and the
//! finished review says it ran weaker (realm @nick/craft, node #752).

mod common;

use common::{fixture, lens, small_run, write_answer};
use craft_review::state;
use craft_review::step::{self, Said};
use craft_step::noted;
use serde_json::{Value, json};

const NOTE: &str = "round 1: 3 task(s) named `consumer-x`, whose prompt body the Codex driver did not find, and ran on the bare task prompt — this run is weaker than a normal one, not broken.";

/// The round's answers written to their files, as its agents wrote them before the signal.
fn answers_landed(step: &Value) {
    for name in ["errors", "intent", "tests"] {
        let id = format!("lens-rust-{name}-r1");
        write_answer(step, &id, &lens(name, &[]).to_string());
    }
}

#[test]
fn a_resume_takes_the_notes_kept_by_an_interrupted_round_into_the_finished_review() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, s) = small_run(repo.path(), out.path());
    answers_landed(&s);
    noted::keep(&run, &[NOTE.to_owned()]).unwrap();
    let resume = Said {
        resume: true,
        ..Said::default()
    };
    let s = step::submit_with(&run, None, &resume).unwrap();
    assert_eq!(
        (s["verdict"].clone(), s["degraded"].clone()),
        (json!("Approve"), json!([NOTE])),
        "{s}"
    );
    let report = std::fs::read_to_string(state::report_path(&run)).unwrap();
    assert!(
        report.contains(&format!(
            "## Degraded\n\nThe host ran part of this review weaker than it asked:\n\n- {NOTE}\n"
        )),
        "{report}"
    );
    assert!(
        !noted::file(&run).exists(),
        "forgotten once the state holds them"
    );
}

#[test]
fn notes_kept_and_said_again_are_named_once() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, s) = small_run(repo.path(), out.path());
    answers_landed(&s);
    noted::keep(&run, &[NOTE.to_owned()]).unwrap();
    let said = [NOTE.to_owned()];
    let s = step::submit_with(
        &run,
        None,
        &Said {
            degraded: &said,
            ..Said::default()
        },
    )
    .unwrap();
    assert_eq!(s["degraded"], json!([NOTE]), "{s}");
}

#[test]
fn a_run_with_no_kept_note_finishes_as_it_did() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, s) = small_run(repo.path(), out.path());
    answers_landed(&s);
    let resume = Said {
        resume: true,
        ..Said::default()
    };
    let s = step::submit_with(&run, None, &resume).unwrap();
    assert_eq!(s["verdict"], json!("Approve"), "{s}");
    assert!(s.get("degraded").is_none(), "{s}");
    let report = std::fs::read_to_string(state::report_path(&run)).unwrap();
    assert!(!report.contains("## Degraded"), "{report}");
}
