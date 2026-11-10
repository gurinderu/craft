//! Nothing to gate is not an unknown signal: a Nix change in a repository with no `flake.nix`, or
//! a Rust file no Cargo package holds, leaves the gate nothing to establish, so it caps nothing.

use std::time::Duration;

use super::tests::{nix_track, repo, setup, tool};
use super::{Status, alone, run, section};
use crate::state::Track;

#[test]
fn a_clean_nix_change_without_a_flake_has_nothing_to_gate() {
    let (repo, tools, run_dir) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    std::fs::remove_file(repo.path().join("flake.nix")).unwrap();
    tool(tools.path(), "nix", "exit 9");
    tool(tools.path(), "statix", "exit 0");
    tool(tools.path(), "deadnix", "exit 0");
    let (gate, seeds) = run(
        repo.path(),
        "HEAD~1",
        &nix_track(),
        &setup(tools.path(), Duration::from_secs(30)),
        run_dir.path(),
    );
    let t = &gate.tracks[0];
    assert_eq!(t.status, Status::Nothing, "{t:?}");
    assert!(seeds.is_empty() && gate.exit().is_none());
    assert_eq!(alone::outcome(&gate), "none");
    let s = section::section(&gate);
    assert!(
        s.contains("**nix**: nothing to gate — nix flake check: no flake.nix"),
        "{s}"
    );
}

#[test]
fn a_rust_file_outside_any_cargo_package_has_nothing_to_gate() {
    let (repo, tools, run_dir) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    std::fs::write(repo.path().join("x.rs"), "fn main() {}\n").unwrap();
    tool(tools.path(), "cargo", "exit 9");
    let (gate, _) = run(
        repo.path(),
        "HEAD~1",
        &[Track::new("rust", vec!["x.rs".into()])],
        &setup(tools.path(), Duration::from_secs(30)),
        run_dir.path(),
    );
    let t = &gate.tracks[0];
    assert_eq!(t.status, Status::Nothing, "{t:?}");
    assert!(
        t.provenance
            .contains("clippy: no Cargo package holds the changed files"),
        "{t:?}"
    );
    assert_eq!(alone::outcome(&gate), "none");
}

#[test]
fn nothing_to_gate_beside_a_pass_passes_and_beside_an_unknown_stays_unknown() {
    let mut acc = super::check::Acc::default();
    acc.check(Status::Nothing);
    acc.check(Status::Pass);
    assert_eq!(acc.status, Some(Status::Pass));
    acc.check(Status::Unknown);
    acc.check(Status::Nothing);
    assert_eq!(acc.status, Some(Status::Unknown));
}
