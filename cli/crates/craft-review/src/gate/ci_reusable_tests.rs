//! A CI map entry on a reusable workflow (realm @nick/craft, node #482): GitHub reports the called
//! job as `<caller> / <job>`, and the gate counts that run for the entry, matrix runs included.

use super::Status;
use super::ci_world::{FMT_GREEN, gated, runs, save, world};
use crate::project::CiEntry;

const LINTS: &str = ".github/workflows/lints.yml";

/// A world whose `pr` workflow calls `lints.yml`, the map holding its clippy job alone.
fn called(list: &[(&str, &str, &str)]) -> super::ci_world::World {
    let w = world(&runs(list), FMT_GREEN);
    let top = w.repo.path();
    let pr = "on: pull_request\njobs:\n  lints:\n    uses: ./.github/workflows/lints.yml\n";
    let lints = "on:\n  workflow_call:\njobs:\n  clippy:\n    strategy:\n      matrix:\n        os: [a, b]\n    steps:\n      - run: cargo clippy --all-targets -- -D warnings\n";
    std::fs::write(top.join(".github/workflows/pr.yml"), pr).unwrap();
    std::fs::write(top.join(LINTS), lints).unwrap();
    let json = serde_json::json!({"check": "lints / clippy", "signal": "clippy", "command": "cargo clippy --all-targets -- -D warnings", "workflow": LINTS});
    let e = CiEntry::confirmed(&json.to_string(), top).unwrap();
    save(w.projects.path(), top, vec![e]);
    w
}

#[test]
fn a_red_run_of_a_called_job_reported_through_its_caller_blocks() {
    let w = called(&[
        ("lints / clippy (a)", "completed", "success"),
        ("lints / clippy (b)", "completed", "failure"),
        ("clippy", "completed", "success"),
    ]);
    let (_, t) = gated(&w);
    assert_eq!(t.status, Status::Fail, "{t:?}");
    assert!(
        t.failed_checks
            .iter()
            .any(|f| f.contains("CI lints / clippy (clippy) is red")),
        "{t:?}"
    );
}

#[test]
fn a_green_called_job_informs_under_its_reported_check() {
    let w = called(&[
        ("lints / clippy (a)", "completed", "success"),
        ("lints / clippy (b)", "completed", "success"),
    ]);
    let (_, t) = gated(&w);
    assert_eq!(t.status, Status::Unknown, "{t:?}");
    assert!(
        t.provenance.contains("checks lints / clippy"),
        "{}",
        t.provenance
    );
}
