//! The gate's CI evidence when its own build is impossible (realm @nick/craft, node #482): green,
//! red, pending and matrix checks of the head; a stale workflow; no map; gh failing; a head that
//! built reading no CI.

use super::Status;
use super::ci_world::{FMT_GREEN, WF, calls, gated, runs, save, short, world};
use super::tests::tool;

#[test]
fn a_green_ci_for_the_head_passes_the_gate_its_build_could_not_establish() {
    let w = world(
        &runs(&[
            ("clippy", "completed", "success"),
            ("tests", "completed", "success"),
        ]),
        FMT_GREEN,
    );
    let (gate, t) = gated(&w);
    assert_eq!(t.status, Status::Pass, "{t:?}");
    let via = format!(
        "clippy, test, fmt via CI (clippy, tests, fmt) for {}",
        short(&w)
    );
    assert!(t.provenance.contains(&via), "{}", t.provenance);
    assert!(gate.exit().is_none());
    assert!(
        !calls(&w, "cargo").contains("pedantic"),
        "pedantic stays skipped"
    );
    let gh = calls(&w, "gh");
    let head = crate::git::git(w.repo.path(), &["rev-parse", "HEAD"]).unwrap();
    assert!(
        gh.contains(&format!(
            "repos/{{owner}}/{{repo}}/commits/{}/check-runs",
            head.trim()
        )),
        "{gh}"
    );
}

#[test]
fn a_red_ci_check_blocks_as_a_local_fail_would() {
    let w = world(
        &runs(&[
            ("clippy", "completed", "success"),
            ("tests", "completed", "failure"),
        ]),
        FMT_GREEN,
    );
    let (gate, t) = gated(&w);
    assert_eq!(t.status, Status::Fail, "{t:?}");
    assert!(
        t.failed_checks
            .iter()
            .any(|f| f.contains("CI tests (test) is red")),
        "{t:?}"
    );
    assert_eq!(gate.exit().unwrap().verdict, "Block");
}

#[test]
fn a_pending_or_absent_check_gives_no_signal_and_says_so() {
    let w = world(
        &runs(&[("clippy", "in_progress", "")]),
        r#"{"total_count":0,"statuses":[]}"#,
    );
    let (_, t) = gated(&w);
    assert_eq!(t.status, Status::Unknown, "{t:?}");
    let notes = t.notes.join("\n");
    assert!(
        notes.contains("no clippy signal") && notes.contains("in_progress"),
        "{notes}"
    );
    assert!(
        notes.contains("no test signal") && notes.contains("no run of `tests`"),
        "{notes}"
    );
}

#[test]
fn an_entry_whose_workflow_changed_is_skipped_and_the_map_named_stale() {
    let w = world(&runs(&[("clippy", "completed", "failure")]), FMT_GREEN);
    std::fs::write(w.repo.path().join(WF), "jobs:\n  lint:\n").unwrap();
    let (_, t) = gated(&w);
    assert_eq!(t.status, Status::Unknown, "{t:?}");
    let notes = t.notes.join("\n");
    assert!(
        notes.contains("CI map is stale") && notes.contains("craft init --propose"),
        "{notes}"
    );
    assert!(calls(&w, "gh").is_empty(), "nothing fresh to read");
}

#[test]
fn without_a_map_or_a_working_gh_the_gate_stays_unknown_with_a_note() {
    let w = world(&runs(&[("clippy", "completed", "success")]), FMT_GREEN);
    std::fs::write(w.tools.path().join("fail"), "").unwrap();
    let (_, t) = gated(&w);
    assert_eq!(t.status, Status::Unknown, "{t:?}");
    assert!(
        t.notes
            .iter()
            .any(|n| n.contains("CI was not read") && n.contains("401")),
        "{t:?}"
    );
    std::fs::remove_file(w.tools.path().join("fail")).unwrap();
    save(w.projects.path(), w.repo.path(), Vec::new());
    std::fs::remove_file(w.tools.path().join("gh-calls")).unwrap();
    let (_, t) = gated(&w);
    assert_eq!(t.status, Status::Unknown, "{t:?}");
    assert!(t.notes.iter().any(|n| n.contains("no CI map")), "{t:?}");
    assert!(calls(&w, "gh").is_empty());
}

#[test]
fn a_build_that_ran_does_not_read_ci() {
    let w = world(&runs(&[("clippy", "completed", "failure")]), FMT_GREEN);
    tool(w.tools.path(), "cargo", "exit 0");
    let (_, t) = gated(&w);
    assert_eq!(t.status, Status::Pass, "{t:?}");
    assert!(calls(&w, "gh").is_empty());
}
