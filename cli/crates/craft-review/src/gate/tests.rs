//! The gate's tools as it reads them, stand-ins on a PATH of their own: the Nix tools' JSON, the
//! budget that cuts a tool short, and a red flake.

use std::path::Path;
use std::time::Duration;

use super::{GateSetup, Status, run};
use crate::state::Track;

fn tool(dir: &Path, name: &str, script: &str) {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
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
fn repo() -> tempfile::TempDir {
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

fn nix_track() -> Vec<Track> {
    vec![Track::new("nix", vec!["a.nix".into()])]
}

fn setup(path: &Path, budget: Duration) -> GateSetup {
    GateSetup {
        budget,
        path: Some(path.as_os_str().to_owned()),
    }
}

#[test]
fn the_nix_tools_seed_what_they_report_on_the_changes_lines() {
    let (repo, tools, run_dir) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    tool(tools.path(), "nix", "exit 0");
    tool(
        tools.path(),
        "statix",
        r#"printf '%s' '{"file":"a.nix","report":[{"note":"Assignment instead of inherit","code":3,"severity":"Warn","diagnostics":[{"at":{"from":{"line":2,"column":3}},"message":"This assignment is better written with `inherit`"}]}]}'; exit 1"#,
    );
    tool(
        tools.path(),
        "deadnix",
        r#"printf '%s\n' '{"file":"a.nix","results":[{"column":9,"line":1,"message":"Unused lambda pattern: self"},{"column":1,"line":9,"message":"Unused let binding: gone"}]}'"#,
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
        "echo 'error: unable to download https://x' >&2; exit 1",
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
        t.provenance.starts_with("`nix flake check`: timed out"),
        "{t:?}"
    );
}
