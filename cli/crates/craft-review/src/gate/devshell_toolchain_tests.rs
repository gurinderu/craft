//! The dev shell's clippy against its rustc, by sysroot: a clippy of another toolchain, or none,
//! is a named unknown before any build; and an E0514 from clippy, in a shell or out of one, is a
//! toolchain mismatch, unknown, never the red it would read as.

use super::Status;
use super::devshell_tests::{LABEL, NIXPKGS_RUSTC, World, gate_of, world};

#[test]
fn nixpkgs_clippy_beside_nixpkgs_rustc_shares_its_sysroot_and_runs() {
    let r = gate_of(&world());
    assert_eq!(r.track().status, Status::Pass, "{:?}", r.gate);
    assert_eq!(r.cargo.lines().count(), 3, "{}", r.cargo);
}

/// The gate where the dev shell's clippy answers as `w` gives: unknown, not red, no clippy run,
/// the reason and each of `seen` named.
fn not_its_rustc(w: &World<'_>, seen: &[&str]) {
    let r = gate_of(w);
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
        notes.contains("no clippy matching its rustc") && notes.contains("clippy did not run"),
        "{notes}"
    );
    for s in seen {
        assert!(notes.contains(s), "{s}: {notes}");
    }
}

#[test]
fn rustups_clippy_of_the_same_release_beside_nixpkgs_rustc_is_a_named_unknown() {
    // The pair a version comparison passes and E0514 refuses: one release, two builds.
    not_its_rustc(
        &World {
            clippy: "echo 'clippy 0.1.99 (58cf8f9c35 2026-10-13)'; exit 0",
            driver: Some("echo /home/u/.rustup/toolchains/1.99.1-x86_64-unknown-linux-gnu"),
            rustc: NIXPKGS_RUSTC,
            ..world()
        },
        &[
            "clippy's sysroot /home/u/.rustup/toolchains/1.99.1-x86_64-unknown-linux-gnu",
            "rustc's /nix/store/r-rustc-1.99.1",
            "`cargo clippy --version`: clippy 0.1.99 (58cf8f9c35 2026-10-13)",
            "`rustc --version`: rustc 1.99.1 (58cf8f9c3 2026-10-13) (built from a source tarball)",
        ],
    );
}

#[test]
fn a_dev_shell_with_no_clippy_or_no_clippy_driver_is_a_named_unknown() {
    not_its_rustc(
        &World {
            clippy: "echo 'error: no such command: `clippy`' >&2; exit 101",
            ..world()
        },
        &["`cargo clippy --version`: not installed"],
    );
    not_its_rustc(
        &World {
            driver: None,
            ..world()
        },
        &["clippy-driver --print sysroot`: exit 127"],
    );
}

/// What clippy prints of a crate another rustc built, as clippy 0.1.99 over nixpkgs' rustc 1.99.1
/// was observed to, and its exit.
const E0514: &str = r#"printf '%s\n' '{"reason":"compiler-message","manifest_path":"Cargo.toml","message":{"level":"error","code":{"code":"E0514"},"message":"found crate `dep` compiled by an incompatible version of rustc","spans":[{"file_name":"src/lib.rs","line_start":1,"is_primary":true}]}}'; exit 101"#;

#[test]
fn an_e0514_from_clippy_is_a_toolchain_mismatch_not_a_red_gate() {
    for files in [&[][..], &["flake.nix"][..]] {
        let r = gate_of(&World {
            files,
            build: E0514,
            ..world()
        });
        let t = r.track();
        assert_eq!(t.status, Status::Unknown, "{:?}", r.gate);
        assert!(t.failed_checks.is_empty(), "not red: {t:?}");
        assert!(r.gate.exit().is_none());
        assert!(
            t.provenance.contains("`: toolchain mismatch: E0514"),
            "{t:?}"
        );
        assert!(r.notes().contains("not a failure"), "{}", r.notes());
    }
}
