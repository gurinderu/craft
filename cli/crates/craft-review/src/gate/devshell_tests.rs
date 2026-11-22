//! The Rust gate inside the checkout's flake dev shell, with stand-ins for nix, cargo and rustc
//! that log how they were called: a default dev shell for this system runs cargo through
//! `nix develop . -c`; none, no flake or no nix runs it as before; a dev shell that does not enter
//! is a named unknown. Its clippy against its rustc: `gate/devshell_toolchain_tests.rs`.

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
pub(super) struct Ran {
    pub gate: Gate,
    pub nix: String,
    pub cargo: String,
}

impl Ran {
    pub(super) fn track(&self) -> &super::Track {
        &self.gate.tracks[0]
    }

    pub(super) fn notes(&self) -> String {
        self.track().notes.join("\n")
    }
}

/// The machine and checkout a gate runs on: the files beside the package, a stand-in nix's
/// answers to `eval` and `develop` (`None`: no nix on the PATH), what `cargo clippy --version`
/// and `rustc --version` run, and the budget.
pub(super) struct World<'a> {
    pub files: &'a [&'a str],
    pub nix: Option<(&'a str, &'a str)>,
    pub clippy: &'a str,
    pub rustc: &'a str,
    pub budget: Duration,
}

pub(super) const HAS_SHELL: &str = "echo true";
pub(super) const ENTERS: &str = ":";

/// A flake with a default dev shell that enters, its clippy its rustc's.
pub(super) fn world() -> World<'static> {
    World {
        files: &["flake.nix"],
        nix: Some((HAS_SHELL, ENTERS)),
        clippy: "echo 'clippy 0.1.99 (b940084d7e 2026-09-28)'; exit 0",
        rustc: "echo 'rustc 1.99.0 (b940084d7 2026-09-28)'",
        budget: Duration::from_secs(30),
    }
}

/// The Rust gate over a package in `w`.
pub(super) fn gate_of(w: &World<'_>) -> Ran {
    let repo = package(None);
    for f in w.files {
        std::fs::write(repo.path().join(f), "{ }\n").unwrap();
    }
    let tools = tempfile::tempdir().unwrap();
    let (nix_log, cargo_log) = (
        tools.path().join("nix.calls"),
        tools.path().join("cargo.calls"),
    );
    if let Some((eval, develop)) = w.nix {
        tool(tools.path(), "nix", &nix(&nix_log, eval, develop));
    }
    let cargo = format!(
        "echo \"$*\" >> '{}'\ncase \"$*\" in \"clippy --version\") {} ;; esac\nexit 0",
        cargo_log.display(),
        w.clippy
    );
    tool(tools.path(), "cargo", &cargo);
    tool(tools.path(), "rustc", w.rustc);
    let run_dir = tempfile::tempdir().unwrap();
    let (gate, _) = run(
        repo.path(),
        "HEAD~1",
        &[Track::new("rust", vec!["src/lib.rs".into()])],
        &setup(tools.path(), w.budget),
        run_dir.path(),
    );
    let read = |p: &Path| std::fs::read_to_string(p).unwrap_or_default();
    Ran {
        gate,
        nix: read(&nix_log),
        cargo: read(&cargo_log),
    }
}

/// The exact nix call that runs a program inside the dev shell, as the stand-in logs it.
pub(super) const DEVELOP: &str =
    "--extra-experimental-features nix-command flakes develop --no-write-lock-file . -c";

/// The exact command a label names a run inside the dev shell by.
pub(super) const LABEL: &str =
    "nix --extra-experimental-features 'nix-command flakes' develop --no-write-lock-file . -c";

#[test]
fn a_default_dev_shell_for_this_system_runs_cargo_inside_it() {
    let r = gate_of(&world());
    assert_eq!(r.track().status, Status::Pass, "{:?}", r.gate);
    let nix: Vec<&str> = r.nix.lines().collect();
    assert_eq!(
        nix.len(),
        5,
        "probe, clippy and rustc versions, two clippy runs: {}",
        r.nix
    );
    assert!(
        nix[0].contains(" eval --json --impure --no-write-lock-file .#devShells --apply ")
            && nix[0].contains("builtins.currentSystem"),
        "{}",
        nix[0]
    );
    assert_eq!(nix[1], format!("{DEVELOP} cargo clippy --version"));
    assert_eq!(nix[2], format!("{DEVELOP} rustc --version"));
    let clippy = format!("{DEVELOP} cargo clippy --manifest-path Cargo.toml --all-targets");
    assert!(nix[3].starts_with(&clippy), "{}", nix[3]);
    assert!(nix[4].contains("clippy::pedantic"), "{}", nix[4]);
    assert_eq!(
        r.cargo.lines().count(),
        3,
        "cargo ran in the shell: {}",
        r.cargo
    );
    let p = &r.track().provenance;
    assert!(p.contains("its shellHook, if any, ran"), "{p}");
    let label = format!("`{LABEL} cargo clippy --manifest-path Cargo.toml --all-targets`: pass");
    assert!(p.contains(&label), "{p}");
}

#[test]
fn no_dev_shell_no_flake_or_no_nix_runs_cargo_as_before() {
    let no_output = "echo \"error: flake 'git+file:///w' does not provide attribute 'packages.x86_64-linux.devShells', 'legacyPackages.x86_64-linux.devShells' or 'devShells'\" >&2; exit 1";
    for (files, answers) in [
        (&["flake.nix"][..], ("echo false", ENTERS)),
        (&["flake.nix"][..], (no_output, ENTERS)),
        (&[][..], (HAS_SHELL, ENTERS)),
    ] {
        let r = gate_of(&World {
            files,
            nix: Some(answers),
            ..world()
        });
        assert_eq!(r.track().status, Status::Pass, "{:?}", r.gate);
        assert!(!r.nix.contains("develop"), "{}", r.nix);
        assert_eq!(r.cargo.lines().count(), 2, "{}", r.cargo);
        assert!(!r.track().provenance.contains("develop"), "{:?}", r.gate);
        let notes = r.notes();
        assert!(
            !notes.contains("shell") && !notes.contains("nix"),
            "{notes}"
        );
        assert_eq!(
            r.nix.is_empty(),
            files.is_empty(),
            "no flake, no probe: {}",
            r.nix
        );
    }
    let r = gate_of(&World {
        nix: None,
        ..world()
    });
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
fn an_envrc_or_shell_nix_without_a_flake_is_named_as_not_entered() {
    let r = gate_of(&World {
        files: &[".envrc", "shell.nix"],
        ..world()
    });
    assert_eq!(r.track().status, Status::Pass, "{:?}", r.gate);
    assert!(r.nix.is_empty(), "{}", r.nix);
    let notes = r.notes();
    assert!(
        notes.contains(".envrc and shell.nix and no flake.nix")
            && notes.contains("enters only a flake's dev shell"),
        "{notes}"
    );
}

#[test]
fn a_dev_shell_that_does_not_enter_is_a_named_unknown_not_a_fallback() {
    let fails =
        "echo 'error: builder for /nix/store/x-rust.drv failed with exit code 1' >&2; exit 1";
    let r = gate_of(&World {
        nix: Some((HAS_SHELL, fails)),
        ..world()
    });
    let t = r.track();
    assert_eq!(t.status, Status::Unknown, "{:?}", r.gate);
    assert!(t.failed_checks.is_empty(), "not red: {t:?}");
    assert!(
        r.cargo.is_empty(),
        "clippy did not run outside it: {}",
        r.cargo
    );
    assert!(r.gate.exit().is_none());
    let part = format!("`{LABEL} cargo clippy --version`: did not enter");
    assert!(t.provenance.contains(&part), "{t:?}");
    let notes = r.notes();
    assert!(
        notes.contains("exit 1, error: builder for /nix/store/x-rust.drv failed")
            && notes.contains("clippy did not run"),
        "{notes}"
    );
}

#[test]
fn a_dev_shell_whose_entry_runs_out_of_time_says_it_timed_out() {
    let r = gate_of(&World {
        nix: Some((HAS_SHELL, "/bin/sleep 30")),
        budget: Duration::from_secs(2),
        ..world()
    });
    let t = r.track();
    assert_eq!(t.status, Status::Unknown, "{:?}", r.gate);
    let part = format!("`{LABEL} cargo clippy --version`: timed out");
    assert!(t.provenance.contains(&part), "{t:?}");
    assert!(r.notes().contains("timed out after"), "{}", r.notes());
    assert!(!r.notes().contains("did not enter"), "{}", r.notes());
}

#[test]
fn a_probe_that_cannot_tell_is_noted_and_cargo_runs_outside() {
    let broken = "echo 'error: getting status of /w/flake.nix: Permission denied' >&2; exit 1";
    let r = gate_of(&World {
        nix: Some((broken, ENTERS)),
        ..world()
    });
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
