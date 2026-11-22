//! The Rust gate inside the checkout's flake dev shell, with stand-ins for nix and cargo that log
//! how they were called: a default dev shell for this system runs cargo through `nix develop . -c`;
//! none, no flake or no nix runs it as before; a dev shell that does not enter is a named unknown.

use std::path::Path;
use std::time::Duration;

use super::tests::{package, setup, tool};
use super::{Gate, Status, run};
use crate::state::Track;

/// The stand-in nix: logs its arguments, answers `eval` with `eval`, and on `develop` runs
/// `develop` and then what follows `-c`.
fn nix(log: &Path, eval: &str, develop: &str) -> String {
    format!(
        r#"echo "$*" >> '{}'
case "$*" in
  *" eval "*) {eval} ;;
  *" develop "*) {develop}
    while [ "$1" != -c ]; do shift; done; shift; exec "$@" ;;
esac"#,
        log.display()
    )
}

/// What one gate came to: the gate, and the nix and cargo calls, one line each.
struct Ran {
    gate: Gate,
    nix: String,
    cargo: String,
}

impl Ran {
    fn track(&self) -> &super::Track {
        &self.gate.tracks[0]
    }

    fn notes(&self) -> String {
        self.track().notes.join("\n")
    }
}

/// The Rust gate over a package, with a `flake.nix` when `flake`, and a stand-in nix answering as
/// `nix_answers` gives (`None`: no nix on the PATH).
fn gate_of(flake: bool, nix_answers: Option<(&str, &str)>) -> Ran {
    let repo = package(None);
    if flake {
        std::fs::write(repo.path().join("flake.nix"), "{ }\n").unwrap();
    }
    let tools = tempfile::tempdir().unwrap();
    let (nix_log, cargo_log) = (
        tools.path().join("nix.calls"),
        tools.path().join("cargo.calls"),
    );
    if let Some((eval, develop)) = nix_answers {
        tool(tools.path(), "nix", &nix(&nix_log, eval, develop));
    }
    tool(
        tools.path(),
        "cargo",
        &format!("echo \"$*\" >> '{}'; exit 0", cargo_log.display()),
    );
    let run_dir = tempfile::tempdir().unwrap();
    let (gate, _) = run(
        repo.path(),
        "HEAD~1",
        &[Track::new("rust", vec!["src/lib.rs".into()])],
        &setup(tools.path(), Duration::from_secs(30)),
        run_dir.path(),
    );
    let read = |p: &Path| std::fs::read_to_string(p).unwrap_or_default();
    Ran {
        gate,
        nix: read(&nix_log),
        cargo: read(&cargo_log),
    }
}

const HAS_SHELL: &str = "echo true";
const ENTERS: &str = ":";

#[test]
fn a_default_dev_shell_for_this_system_runs_cargo_inside_it() {
    let r = gate_of(true, Some((HAS_SHELL, ENTERS)));
    assert_eq!(r.track().status, Status::Pass, "{:?}", r.gate);
    let nix: Vec<&str> = r.nix.lines().collect();
    assert_eq!(
        nix.len(),
        4,
        "the probe, the entry, clippy and the pedantic pass: {}",
        r.nix
    );
    assert!(
        nix[0].contains(" eval --json --impure --no-write-lock-file .#devShells --apply ")
            && nix[0].contains("builtins.currentSystem"),
        "{}",
        nix[0]
    );
    let develop =
        "--extra-experimental-features nix-command flakes develop --no-write-lock-file . -c cargo";
    assert_eq!(nix[1], format!("{develop} --version"));
    assert!(
        nix[2].starts_with(&format!(
            "{develop} clippy --manifest-path Cargo.toml --all-targets"
        )),
        "{}",
        nix[2]
    );
    assert!(nix[3].contains("clippy::pedantic"), "{}", nix[3]);
    assert_eq!(
        r.cargo.lines().count(),
        3,
        "cargo ran in the shell: {}",
        r.cargo
    );
    let p = &r.track().provenance;
    assert!(p.contains("shellHook ran"), "{p}");
    assert!(
        p.contains(
            "`nix develop . -c cargo clippy --manifest-path Cargo.toml --all-targets`: pass"
        ),
        "{p}"
    );
}

#[test]
fn no_dev_shell_no_flake_or_no_nix_runs_cargo_as_before() {
    let no_output = "echo \"error: flake 'git+file:///w' does not provide attribute 'packages.x86_64-linux.devShells', 'legacyPackages.x86_64-linux.devShells' or 'devShells'\" >&2; exit 1";
    for (flake, answers) in [
        (true, Some(("echo false", ENTERS))),
        (true, Some((no_output, ENTERS))),
        (false, Some((HAS_SHELL, ENTERS))),
    ] {
        let r = gate_of(flake, answers);
        assert_eq!(r.track().status, Status::Pass, "{:?}", r.gate);
        assert!(!r.nix.contains("develop"), "{}", r.nix);
        assert_eq!(r.cargo.lines().count(), 2, "{}", r.cargo);
        assert!(
            !r.track().provenance.contains("nix develop"),
            "{:?}",
            r.gate
        );
        assert!(
            !r.notes().contains("shell") && !r.notes().contains("nix"),
            "nothing to say of a dev shell: {:?}",
            r.gate
        );
        assert_eq!(r.nix.is_empty(), !flake, "no flake, no probe: {}", r.nix);
    }
    let r = gate_of(true, None);
    assert_eq!(r.track().status, Status::Pass, "{:?}", r.gate);
    assert_eq!(r.cargo.lines().count(), 2, "{}", r.cargo);
    assert!(r.notes().contains("nix is not installed"), "{}", r.notes());
    assert!(
        !r.track().missing.iter().any(|m| m == "nix"),
        "{:?}",
        r.gate
    );
}

#[test]
fn a_dev_shell_that_does_not_enter_is_a_named_unknown_not_a_fallback() {
    let fails =
        "echo 'error: builder for /nix/store/x-rust.drv failed with exit code 1' >&2; exit 1";
    let r = gate_of(true, Some((HAS_SHELL, fails)));
    let t = r.track();
    assert_eq!(t.status, Status::Unknown, "{:?}", r.gate);
    assert!(t.failed_checks.is_empty(), "not red: {t:?}");
    assert!(
        r.cargo.is_empty(),
        "clippy did not run outside it: {}",
        r.cargo
    );
    assert!(r.gate.exit().is_none());
    assert!(
        t.provenance
            .contains("`nix develop . -c cargo --version`: did not enter"),
        "{t:?}"
    );
    let notes = r.notes();
    assert!(
        notes.contains("exit 1, error: builder for /nix/store/x-rust.drv failed")
            && notes.contains("clippy did not run"),
        "{notes}"
    );
}

#[test]
fn a_probe_that_cannot_tell_is_noted_and_cargo_runs_outside() {
    let broken = "echo 'error: getting status of /w/flake.nix: Permission denied' >&2; exit 1";
    let r = gate_of(true, Some((broken, ENTERS)));
    assert_eq!(r.track().status, Status::Pass, "{:?}", r.gate);
    assert!(!r.nix.contains("develop"), "{}", r.nix);
    assert_eq!(r.cargo.lines().count(), 2, "{}", r.cargo);
    let notes = r.notes();
    assert!(
        notes.contains("could not be read")
            && notes.contains("Permission denied")
            && notes.contains("ran outside it"),
        "{notes}"
    );
}
