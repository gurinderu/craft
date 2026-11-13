//! The gate's tools as it reads them, stand-ins on a PATH of their own: the Nix tools' JSON, the
//! budget that cuts a tool short, and a red flake.

use std::path::Path;
use std::time::Duration;

use super::{GateSetup, Status, run};
use crate::state::Track;

#[path = "../../../../test-support/exe.rs"]
mod exe;

pub(super) fn tool(dir: &Path, name: &str, script: &str) {
    exe::write_executable(&dir.join(name), &format!("#!/bin/sh\n{script}\n")).unwrap();
}

fn git(dir: &Path, args: &[&str]) {
    let ok = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .unwrap();
    assert!(ok.status.success(), "git {args:?}");
}

/// A repository whose first commit holds `flake.nix`, the second adding `a.nix` with three lines.
pub(super) fn repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    git(d, &["init", "-q", "-b", "main"]);
    std::fs::write(d.join("flake.nix"), "{ }\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "init"]);
    std::fs::write(d.join("a.nix"), "{ pkgs, self, ... }:\n{ x = x; }\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "feat: a"]);
    dir
}

pub(super) fn nix_track() -> Vec<Track> {
    vec![Track::new("nix", vec!["a.nix".into()])]
}

pub(super) fn setup(path: &Path, budget: Duration) -> GateSetup {
    GateSetup {
        budget,
        path: Some(path.as_os_str().to_owned()),
        scope: None,
        projects: None,
        locked: false,
    }
}

#[test]
fn the_nix_tools_seed_what_they_report_on_the_changes_lines() {
    let (repo, tools, run_dir) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    // A reviewer's own diff settings change no prefix the gate reads its added lines by.
    git(repo.path(), &["config", "diff.noprefix", "true"]);
    git(repo.path(), &["config", "diff.mnemonicPrefix", "true"]);
    git(repo.path(), &["config", "color.diff", "always"]);
    tool(tools.path(), "nix", "exit 0");
    // Each answers only when the file operand follows `--`, so none is read as an option.
    tool(
        tools.path(),
        "statix",
        r#"case "$*" in *"-- a.nix") ;; *) exit 9 ;; esac
printf '%s' '{"file":"a.nix","report":[{"note":"Assignment instead of inherit","code":3,"severity":"Warn","diagnostics":[{"at":{"from":{"line":2,"column":3}},"message":"This assignment is better written with `inherit`"}]}]}'; exit 1"#,
    );
    tool(
        tools.path(),
        "deadnix",
        r#"case "$*" in *"-- a.nix") ;; *) exit 9 ;; esac
printf '%s\n' '{"file":"a.nix","results":[{"column":9,"line":1,"message":"Unused lambda pattern: self"},{"column":1,"line":9,"message":"Unused let binding: gone"}]}'"#,
    );
    let (gate, seeds) = run(
        repo.path(),
        "HEAD~1",
        &nix_track(),
        &setup(tools.path(), Duration::from_secs(30)),
        run_dir.path(),
    );
    let t = &gate.tracks[0];
    assert_eq!((t.status, t.seeds), (Status::Pass, 2), "{t:?}");
    let got: Vec<(&str, &str, &str, u64)> = seeds
        .iter()
        .map(|s| {
            (
                s["source"].as_str().unwrap(),
                s.get("toolRule").and_then(|r| r.as_str()).unwrap_or(""),
                s["title"].as_str().unwrap(),
                s["line"].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        got,
        [
            (
                "statix",
                "W03",
                "This assignment is better written with `inherit`",
                2
            ),
            ("deadnix", "", "Unused lambda pattern: self", 1),
        ]
    );
    assert!(
        seeds
            .iter()
            .all(|s| s["ruleId"] == "MNT-001" && s["profile"] == "nix")
    );
    assert!(gate.exit().is_none());
}

#[test]
fn a_red_flake_fails_the_gate_but_one_this_machine_stopped_is_unknown() {
    let (repo, tools, run_dir) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let budget = Duration::from_secs(30);
    tool(
        tools.path(),
        "nix",
        "echo 'error: attribute x missing' >&2; exit 1",
    );
    let (gate, _) = run(
        repo.path(),
        "HEAD~1",
        &nix_track(),
        &setup(tools.path(), budget),
        run_dir.path(),
    );
    assert_eq!(gate.tracks[0].status, Status::Fail);
    assert_eq!(
        gate.tracks[0].failed_checks,
        ["nix flake check: error: attribute x missing"]
    );
    assert!(
        gate.exit()
            .unwrap()
            .line
            .contains("mechanical gate is red (nix)")
    );
    tool(
        tools.path(),
        "nix",
        "echo \"error: unable to download 'https://x/y.tar.gz': Could not resolve hostname (6) Could not resolve host: x\" >&2; exit 1",
    );
    let (gate, _) = run(
        repo.path(),
        "HEAD~1",
        &nix_track(),
        &setup(tools.path(), budget),
        run_dir.path(),
    );
    assert_eq!(gate.tracks[0].status, Status::Unknown);
    assert!(gate.exit().is_none());
    assert_eq!(
        gate.tracks[0].missing,
        ["statix", "deadnix"],
        "not installed, named"
    );
    // A check the change broke may say "Permission denied" itself: that is the change's, red.
    tool(
        tools.path(),
        "nix",
        "echo 'error: builder for check failed: open: Permission denied' >&2; exit 1",
    );
    let (gate, _) = run(
        repo.path(),
        "HEAD~1",
        &nix_track(),
        &setup(tools.path(), budget),
        run_dir.path(),
    );
    assert_eq!(gate.tracks[0].status, Status::Fail);
    // A machine fault at another daemon socket or in the store's own database is the machine's.
    for fault in [
        "error: cannot connect to socket at '/run/nix/daemon.sock': Connection refused",
        "error: opening lock file '/nix/var/nix/db/big-lock': Permission denied",
    ] {
        tool(
            tools.path(),
            "nix",
            &format!("echo \"{fault}\" >&2; exit 1"),
        );
        let (gate, _) = run(
            repo.path(),
            "HEAD~1",
            &nix_track(),
            &setup(tools.path(), budget),
            run_dir.path(),
        );
        assert_eq!(gate.tracks[0].status, Status::Unknown, "{fault}");
    }
}

#[test]
fn a_tool_past_the_budget_is_cut_and_its_signal_unknown() {
    let (repo, tools, run_dir) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    tool(tools.path(), "nix", "while :; do :; done");
    let started = std::time::Instant::now();
    let (gate, _) = run(
        repo.path(),
        "HEAD~1",
        &nix_track(),
        &setup(tools.path(), Duration::from_millis(500)),
        run_dir.path(),
    );
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "killed, not waited for"
    );
    let t = &gate.tracks[0];
    assert_eq!(t.status, Status::Unknown);
    assert!(
        t.notes
            .iter()
            .any(|n| n.contains("hit the gate's time budget")),
        "{t:?}"
    );
    assert!(
        t.provenance
            .starts_with("`nix flake check --no-write-lock-file`: timed out"),
        "{t:?}"
    );
}

#[test]
fn a_diagnostic_is_placed_from_the_package_it_was_reported_in() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    git(d, &["init", "-q", "-b", "main"]);
    std::fs::write(d.join("README.md"), "x\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "init"]);
    for f in ["Cargo.toml", "crates/a/Cargo.toml"] {
        std::fs::create_dir_all(d.join(f).parent().unwrap()).unwrap();
        std::fs::write(d.join(f), "[package]\n").unwrap();
    }
    for f in ["src/lib.rs", "crates/a/src/lib.rs"] {
        std::fs::create_dir_all(d.join(f).parent().unwrap()).unwrap();
        std::fs::write(d.join(f), "pub fn f() {}\n").unwrap();
    }
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "feat: two packages"]);
    let top = crate::git::toplevel(d).unwrap();
    // The package `crates/a`, its own workspace, names its file from its own directory.
    let diag = serde_json::json!({"reason": "compiler-message", "manifest_path": top.join("crates/a/Cargo.toml"),
        "message": {"level": "warning", "code": {"code": "clippy::x"}, "message": "m",
        "spans": [{"file_name": "src/lib.rs", "line_start": 1, "is_primary": true}]}});
    let tools = tempfile::tempdir().unwrap();
    tool(
        tools.path(),
        "cargo",
        &format!("case \"$*\" in *crates/a*) printf '%s\\n' '{diag}' ;; esac"),
    );
    let files: Vec<String> = ["src/lib.rs", "crates/a/src/lib.rs", "Cargo.toml"]
        .map(String::from)
        .to_vec();
    let run_dir = tempfile::tempdir().unwrap();
    let (gate, seeds) = run(
        d,
        "HEAD~1",
        &[Track::new("rust", files)],
        &setup(tools.path(), Duration::from_secs(30)),
        run_dir.path(),
    );
    assert_eq!(gate.tracks[0].status, Status::Pass, "{gate:?}");
    let at: Vec<&str> = seeds.iter().map(|s| s["file"].as_str().unwrap()).collect();
    assert_eq!(
        at,
        ["crates/a/src/lib.rs"],
        "not the top package's src/lib.rs"
    );
}

/// A repository with a package at its top, its lockfile `lock` committed when there is one.
pub(super) fn package(lock: Option<&str>) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    git(d, &["init", "-q", "-b", "main"]);
    std::fs::write(d.join("Cargo.toml"), "[package]\n").unwrap();
    if let Some(l) = lock {
        std::fs::write(d.join("Cargo.lock"), l).unwrap();
    }
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "init"]);
    std::fs::create_dir_all(d.join("src")).unwrap();
    std::fs::write(d.join("src/lib.rs"), "pub fn f() {}\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "feat: f"]);
    dir
}

/// The gate over `repo`'s package with a `cargo` running `script`, its budget `budget`.
fn clippy_with(repo: &Path, script: &str, budget: Duration) -> super::Gate {
    let tools = tempfile::tempdir().unwrap();
    tool(tools.path(), "cargo", script);
    let run_dir = tempfile::tempdir().unwrap();
    let files = vec!["src/lib.rs".to_owned()];
    let (gate, _) = run(
        repo,
        "HEAD~1",
        &[Track::new("rust", files)],
        &setup(tools.path(), budget),
        run_dir.path(),
    );
    gate
}

#[test]
fn clippy_builds_without_locked_and_leaves_the_lockfile_as_it_was() {
    let writes = "printf 'rewritten' > Cargo.lock";
    let kept = package(Some("pinned\n"));
    let gate = clippy_with(kept.path(), writes, Duration::from_secs(30));
    assert_eq!(gate.tracks[0].status, Status::Pass, "{gate:?}");
    assert!(!gate.tracks[0].provenance.contains("--locked"));
    let lock = std::fs::read_to_string(kept.path().join("Cargo.lock")).unwrap();
    assert_eq!(lock, "pinned\n", "put back");
    let none = package(None);
    clippy_with(none.path(), writes, Duration::from_secs(30));
    assert!(!none.path().join("Cargo.lock").exists(), "none written");
    // Killed by the budget after writing it, the lockfile is still put back.
    let cut = package(Some("pinned\n"));
    let gate = clippy_with(
        cut.path(),
        &format!("{writes}; while :; do :; done"),
        Duration::from_millis(500),
    );
    assert_eq!(gate.tracks[0].status, Status::Unknown);
    let lock = std::fs::read_to_string(cut.path().join("Cargo.lock")).unwrap();
    assert_eq!(lock, "pinned\n");
}
