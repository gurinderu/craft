//! A held CI map entry whose check holds `${{ … }}` (realm @nick/craft, node #482): GitHub names
//! no run so, and the gate says so plainly instead of finding no run.

use super::Status;
use super::ci_world::{FMT_GREEN, entry, gated, runs, save, world};

#[test]
fn a_held_check_holding_an_expression_is_named_and_skipped() {
    let w = world(
        &runs(&[("clippy (amd64)", "completed", "failure")]),
        FMT_GREEN,
    );
    let top = w.repo.path();
    let mut dead = entry(
        top,
        "clippy",
        "clippy",
        "cargo clippy --all-targets -- -D warnings",
    );
    dead.check = "clippy (${{ matrix.arch }})".to_owned();
    save(w.projects.path(), top, vec![dead]);
    let (_, t) = gated(&w);
    assert_eq!(t.status, Status::Unknown, "skipped, not read: {t:?}");
    let notes = t.notes.join("\n");
    assert!(
        notes.contains("clippy (${{ matrix.arch }})")
            && notes.contains("holds an unexpanded `${{ … }}` expression")
            && notes.contains("craft init --propose"),
        "{notes}"
    );
}

#[test]
fn a_held_entry_a_sibling_workflow_added_since_collides_with_is_named_and_skipped() {
    let w = world(
        &runs(&[
            ("tests (docs)", "completed", "failure"),
            ("tests", "completed", "success"),
        ]),
        FMT_GREEN,
    );
    let docs = ".github/workflows/docs.yml";
    let wf = "jobs:\n  docs:\n    name: tests (docs)\n    steps:\n      - run: mdbook test\n";
    std::fs::write(w.repo.path().join(docs), wf).unwrap();
    let (_, t) = gated(&w);
    assert_ne!(
        t.status,
        Status::Fail,
        "the sibling's red is not counted: {t:?}"
    );
    let notes = t.notes.join("\n");
    assert!(
        notes.contains("the CI map entry `tests` was skipped")
            && notes.contains("\"tests (docs)\"")
            && notes.contains(docs)
            && notes.contains("craft init --propose"),
        "{notes}"
    );
}
