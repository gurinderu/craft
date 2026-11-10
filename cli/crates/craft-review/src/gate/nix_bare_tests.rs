//! A Nix change in a repository with no `flake.nix`: its linters are the whole gate, so they
//! establish it — both clean is nothing to gate, one that did not run leaves it unknown and caps
//! the verdict at Warning (realm @nick/craft, node #487).

use std::time::Duration;

use super::tests::{nix_track, repo, setup, tool};
use super::{Gate, Status, alone, run, unknown};

/// The gate over the test repository with its `flake.nix` removed and `tools` on PATH.
pub(super) fn bare(tools: &[(&str, &str)]) -> Gate {
    let (repo, dir, run_dir) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    std::fs::remove_file(repo.path().join("flake.nix")).unwrap();
    for (name, script) in tools {
        tool(dir.path(), name, script);
    }
    let (gate, _) = run(
        repo.path(),
        "HEAD~1",
        &nix_track(),
        &setup(dir.path(), Duration::from_secs(30)),
        run_dir.path(),
    );
    gate
}

fn names(gate: &Gate, linter: &str) -> bool {
    let t = &gate.tracks[0];
    t.missing.iter().any(|m| m == linter) && t.notes.iter().any(|n| n.contains(linter))
}

#[test]
fn no_flake_and_no_linter_is_unknown_and_caps_at_warning() {
    let gate = bare(&[]);
    let t = &gate.tracks[0];
    assert_eq!(t.status, Status::Unknown, "{t:?}");
    assert_eq!(alone::outcome(&gate), "unknown");
    assert_eq!(
        unknown::profiles(&gate),
        ["nix"],
        "the cap holds Approve at Warning"
    );
    assert!(unknown::reason(&gate).is_some());
    assert!(names(&gate, "statix") && names(&gate, "deadnix"), "{t:?}");
}

#[test]
fn no_flake_and_both_linters_clean_has_nothing_to_gate() {
    let gate = bare(&[("statix", "exit 0"), ("deadnix", "exit 0")]);
    let t = &gate.tracks[0];
    assert_eq!(t.status, Status::Nothing, "{t:?}");
    assert_eq!(alone::outcome(&gate), "none");
    assert!(
        unknown::profiles(&gate).is_empty(),
        "nothing caps the Approve"
    );
}

#[test]
fn no_flake_and_one_linter_missing_is_unknown_and_names_it() {
    let gate = bare(&[("statix", "exit 0")]);
    let t = &gate.tracks[0];
    assert_eq!(t.status, Status::Unknown, "{t:?}");
    assert!(names(&gate, "deadnix"), "{t:?}");
    assert!(!t.notes.iter().any(|n| n.contains("statix")), "{t:?}");
}

#[test]
fn no_flake_and_a_linter_timed_out_is_unknown() {
    let (repo, dir, run_dir) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    std::fs::remove_file(repo.path().join("flake.nix")).unwrap();
    tool(dir.path(), "statix", "exit 0");
    tool(dir.path(), "deadnix", "while :; do :; done");
    let (gate, _) = run(
        repo.path(),
        "HEAD~1",
        &nix_track(),
        &setup(dir.path(), Duration::from_millis(500)),
        run_dir.path(),
    );
    let t = &gate.tracks[0];
    assert_eq!(t.status, Status::Unknown, "{t:?}");
    assert!(t.notes.iter().any(|n| n.contains("deadnix")), "{t:?}");
}

#[test]
fn with_a_flake_a_missing_linter_keeps_the_flake_checks_status() {
    let (repo, dir, run_dir) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    tool(dir.path(), "nix", "exit 0");
    let (gate, _) = run(
        repo.path(),
        "HEAD~1",
        &nix_track(),
        &setup(dir.path(), Duration::from_secs(30)),
        run_dir.path(),
    );
    assert_eq!(gate.tracks[0].status, Status::Pass, "{:?}", gate.tracks[0]);
}
