//! What the gate takes from GitHub's answer (realm @nick/craft, node #482): a re-run supersedes
//! within its check suite but a red in another suite stays red; a set larger than one page, or a
//! tree with uncommitted changes, gives no signal; a status `error` is red.

use super::Status;
use super::ci_world::{FMT_GREEN, calls, gated, runs, short, suited, world};

#[test]
fn every_run_of_a_matrix_check_counts_and_a_rerun_supersedes_within_its_suite() {
    let w = world(
        &runs(&[
            ("clippy", "completed", "failure"),
            ("clippy", "completed", "success"),
            ("tests (stable)", "completed", "success"),
            ("tests (beta)", "completed", "success"),
        ]),
        FMT_GREEN,
    );
    let (_, t) = gated(&w);
    assert_eq!(t.status, Status::Unknown, "{t:?}");
    let green = format!("CI for {}: clippy, test, fmt green", short(&w));
    assert!(t.provenance.contains(&green), "{}", t.provenance);
}

#[test]
fn a_red_in_one_suite_is_not_dropped_by_a_later_green_of_the_same_name_in_another() {
    let w = world(
        &suited(&[
            ("clippy", "completed", "failure", 1),
            ("clippy", "completed", "success", 2),
            ("tests", "completed", "success", 1),
        ]),
        FMT_GREEN,
    );
    let (gate, t) = gated(&w);
    assert_eq!(t.status, Status::Fail, "{t:?}");
    assert_eq!(gate.exit().unwrap().verdict, "Block");
}

#[test]
fn more_check_runs_than_one_page_gives_no_signal() {
    let page = runs(&[
        ("clippy", "completed", "success"),
        ("tests", "completed", "success"),
    ]);
    let w = world(
        &page.replace(r#""total_count":2"#, r#""total_count":140"#),
        FMT_GREEN,
    );
    let (_, t) = gated(&w);
    assert_eq!(t.status, Status::Unknown, "{t:?}");
    assert!(!t.provenance.contains("via CI"), "{}", t.provenance);
    let notes = t.notes.join("\n");
    assert!(
        notes.contains("140 check runs") && notes.contains("one page"),
        "{notes}"
    );
}

#[test]
fn more_statuses_than_one_page_gives_no_signal() {
    let green = runs(&[
        ("clippy", "completed", "success"),
        ("tests", "completed", "success"),
    ]);
    let w = world(
        &green,
        &FMT_GREEN.replace(r#""total_count":1"#, r#""total_count":120"#),
    );
    let (_, t) = gated(&w);
    assert_eq!(t.status, Status::Unknown, "{t:?}");
    assert!(t.notes.join("\n").contains("120 commit statuses"), "{t:?}");
}

#[test]
fn a_status_in_error_is_red() {
    let green = runs(&[
        ("clippy", "completed", "success"),
        ("tests", "completed", "success"),
    ]);
    let w = world(
        &green,
        &FMT_GREEN.replace(r#""state":"success"}"#, r#""state":"error"}"#),
    );
    let (_, t) = gated(&w);
    assert_eq!(t.status, Status::Fail, "{t:?}");
    assert!(
        t.failed_checks
            .iter()
            .any(|f| f.contains("CI fmt (fmt) is red")),
        "{t:?}"
    );
}

#[test]
fn a_tree_with_uncommitted_changes_does_not_read_ci_for_its_head() {
    let w = world(
        &runs(&[
            ("clippy", "completed", "success"),
            ("tests", "completed", "success"),
        ]),
        FMT_GREEN,
    );
    std::fs::write(w.repo.path().join("src/lib.rs"), "pub fn g() {}\n").unwrap();
    let (_, t) = gated(&w);
    assert_eq!(t.status, Status::Unknown, "{t:?}");
    assert!(!t.provenance.contains("via CI"), "{}", t.provenance);
    assert!(
        t.notes.iter().any(|n| n.contains("uncommitted changes")),
        "{t:?}"
    );
    assert!(calls(&w, "gh").is_empty(), "CI for HEAD is not read");
}

#[test]
fn a_green_ci_says_it_brings_no_line_seeds() {
    let w = world(
        &runs(&[
            ("clippy", "completed", "success"),
            ("tests", "completed", "success"),
        ]),
        FMT_GREEN,
    );
    let (_, t) = gated(&w);
    assert_eq!(t.status, Status::Unknown, "{t:?}");
    let via = "(checks clippy, tests, fmt) — informs only, not a pass";
    assert!(t.provenance.contains(via), "{}", t.provenance);
    assert!(
        t.provenance
            .contains("no line seeds: CI results carry none"),
        "{}",
        t.provenance
    );
}
