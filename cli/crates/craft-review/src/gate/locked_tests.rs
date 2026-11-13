//! In craft's own worktree of a PR (`GateSetup::locked`), shared by every run on its head, clippy
//! runs `--locked` where a lockfile is, so no run writes a tracked file there; a lockfile cargo
//! would update leaves the build unknown, named, not a crash. Elsewhere it builds as before.

use std::time::Duration;

use super::tests::{package, setup, tool};
use super::{Status, run};
use crate::state::Track;

/// The gate over a package whose lockfile is `lock`, `locked` as given, with a `cargo` that logs
/// its arguments and then runs `script`: the gate, and what cargo was called with.
fn gate_of(lock: Option<&str>, locked: bool, script: &str) -> (super::Gate, String) {
    let repo = package(lock);
    let tools = tempfile::tempdir().unwrap();
    let log = tools.path().join("calls");
    let logged = format!("echo \"$*\" >> '{}'; {script}", log.display());
    tool(tools.path(), "cargo", &logged);
    let run_dir = tempfile::tempdir().unwrap();
    let mut setup = setup(tools.path(), Duration::from_secs(30));
    setup.locked = locked;
    let (gate, _) = run(
        repo.path(),
        "HEAD~1",
        &[Track::new("rust", vec!["src/lib.rs".into()])],
        &setup,
        run_dir.path(),
    );
    (gate, std::fs::read_to_string(log).unwrap_or_default())
}

#[test]
fn in_crafts_worktree_clippy_runs_locked_and_names_it() {
    let (gate, calls) = gate_of(Some("pinned\n"), true, "exit 0");
    assert_eq!(gate.tracks[0].status, Status::Pass, "{gate:?}");
    assert!(
        calls.lines().count() == 2 && calls.lines().all(|l| l.contains("--locked")),
        "the gate's run and the pedantic pass: {calls}"
    );
    assert!(
        gate.tracks[0]
            .provenance
            .contains("--all-targets --locked`: pass")
    );
}

#[test]
fn elsewhere_or_with_no_lockfile_clippy_runs_as_before() {
    let (_, calls) = gate_of(Some("pinned\n"), false, "exit 0");
    assert!(!calls.contains("--locked"), "{calls}");
    // No lockfile to hold cargo to: the one it writes is untracked and put back as none.
    let (gate, calls) = gate_of(None, true, "exit 0");
    assert!(!calls.contains("--locked"), "{calls}");
    assert_eq!(gate.tracks[0].status, Status::Pass, "{gate:?}");
}

#[test]
fn a_lockfile_cargo_would_update_leaves_the_build_unknown_and_named() {
    let refused = "echo 'error: cannot update the lock file /w/Cargo.lock because --locked was passed to prevent this' >&2; exit 101";
    let (gate, _) = gate_of(Some("pinned\n"), true, refused);
    let t = &gate.tracks[0];
    assert_eq!(t.status, Status::Unknown, "{gate:?}");
    assert!(t.failed_checks.is_empty(), "not red: {t:?}");
    let notes = t.notes.join("\n");
    assert!(
        notes.contains("cannot update the lock file") && notes.contains("not up to date"),
        "{notes}"
    );
}
