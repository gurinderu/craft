//! The dev shell's clippy against its rustc: a clippy of another toolchain, or none, is a named
//! unknown before any build, never the red a host clippy-driver's E0514 would give.

use super::Status;
use super::devshell_tests::{LABEL, World, gate_of, world};
use super::devshell_toolchain::same_toolchain;

#[test]
fn clippy_and_rustc_of_one_toolchain_match() {
    let stable = "rustc 1.99.0 (b940084d7 2026-09-28)";
    assert!(same_toolchain(
        "clippy 0.1.99 (b940084d7e 2026-09-28)",
        stable
    ));
    assert!(same_toolchain(
        "clippy 0.1.100-nightly (0123abcd 2026-11-01)",
        "rustc 1.100.0-nightly (0123abcd9 2026-11-01)"
    ));
    // A build that prints no commit is held to its release alone.
    assert!(same_toolchain(
        "clippy 0.1.85",
        "rustc 1.85.1 (4eb161250 2025-03-15)"
    ));
    for other in [
        "clippy 0.1.98 (b940084d7e 2026-09-28)",
        "clippy 0.1.99 (ffff00000 2026-09-28)",
        "clippy 0.1.99 (b940084d7e 2026-09-29)",
        "clippy 0.1.9 (b940084d7e 2026-09-28)",
        "",
        "error: something",
    ] {
        assert!(!same_toolchain(other, stable), "{other}");
    }
    assert!(!same_toolchain("clippy 0.1.99", ""));
}

/// The gate where the dev shell's clippy answers `clippy` and its rustc `rustc`: unknown, not red,
/// no clippy run, the reason named.
fn not_its_rustc(clippy: &str, rustc: &str, seen: &str) {
    let r = gate_of(&World {
        clippy,
        rustc,
        ..world()
    });
    let t = r.track();
    assert_eq!(t.status, Status::Unknown, "{:?}", r.gate);
    assert!(t.failed_checks.is_empty(), "not red: {t:?}");
    assert!(r.gate.exit().is_none());
    assert_eq!(
        r.cargo.trim(),
        "clippy --version",
        "no clippy run: {}",
        r.cargo
    );
    assert!(
        t.provenance
            .contains("the flake's dev shell: no clippy matching its rustc"),
        "{t:?}"
    );
    assert!(
        !t.provenance
            .contains(&format!("`{LABEL} cargo clippy --manifest-path")),
        "{t:?}"
    );
    let notes = r.notes();
    assert!(
        notes.contains("no clippy matching its rustc")
            && notes.contains("E0514")
            && notes.contains(seen)
            && notes.contains("clippy did not run"),
        "{notes}"
    );
}

#[test]
fn a_dev_shell_with_another_toolchains_clippy_is_a_named_unknown() {
    let host = "echo 'clippy 0.1.99 (b940084d7e 2026-09-28)'; exit 0";
    let shell = "echo 'rustc 1.85.0 (4d91de4e4 2025-02-17)'";
    not_its_rustc(
        host,
        shell,
        "`rustc --version`: rustc 1.85.0 (4d91de4e4 2025-02-17)",
    );
}

#[test]
fn a_dev_shell_and_host_with_no_clippy_is_a_named_unknown() {
    let none = "echo 'error: no such command: `clippy`' >&2; exit 101";
    not_its_rustc(
        none,
        "echo 'rustc 1.99.0 (b940084d7 2026-09-28)'",
        "not installed",
    );
}
