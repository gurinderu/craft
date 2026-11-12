//! A stopped `craft review run`, end to end (realm @nick/craft, node #40): a host's tool stops it
//! with SIGTERM to craft alone — the OpenCode and pi tools kill the process they spawned, the
//! wrapper having `exec`ed into craft — while a task's process and its grandchild run in a group of
//! their own. craft stops that group, files the run INCOMPLETE, says how to resume it, and exits
//! with 128 + 15 — its record naming the host its tasks ran in (`runtime`).
#![cfg(target_os = "linux")]
#![expect(
    clippy::unwrap_used,
    reason = "the fixture helpers fail the test loudly, like the tests they serve"
)]

mod common;

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// A stand-in `codex exec` that hangs with a grandchild, both pids recorded beside it.
const HANGING_CODEX: &str = "#!/bin/sh\ncat > /dev/null\nsleep 300 &\necho $! > \"$(dirname \"$0\")/grandchild\"\necho $$ > \"$(dirname \"$0\")/pid.tmp\"; mv \"$(dirname \"$0\")/pid.tmp\" \"$(dirname \"$0\")/pid\"\nwait\n";

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
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

/// A repository whose branch adds a Rust change over `origin/main`.
fn reviewed(dir: &Path) {
    std::fs::create_dir_all(dir.join("src")).unwrap();
    git(dir, &["init", "-q", "-b", "main"]);
    std::fs::write(
        dir.join("Cargo.toml"),
        "[package]\nname = \"s\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    )
    .unwrap();
    std::fs::write(dir.join("src/lib.rs"), "pub fn f() -> u8 { 1 }\n").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-qm", "init"]);
    git(dir, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    std::fs::write(
        dir.join("src/lib.rs"),
        "pub fn f(x: &[u8]) -> u8 { x[1] }\n",
    )
    .unwrap();
    git(dir, &["commit", "-qam", "feat: index"]);
}

fn pid_in(dir: &Path, name: &str) -> u32 {
    std::fs::read_to_string(dir.join(name))
        .unwrap()
        .trim()
        .parse()
        .unwrap()
}

/// Gone, or a zombie (killed, not yet reaped).
fn gone(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat")).map_or(true, |s| {
        s.rsplit(')')
            .next()
            .is_some_and(|rest| rest.trim_start().starts_with('Z'))
    })
}

fn wait_until(what: &str, within: Duration, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + within;
    while !done() {
        assert!(Instant::now() < deadline, "{what}: not within {within:?}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn sigterm_to_craft_stops_the_tasks_and_files_the_run_incomplete() {
    let tmp = tempfile::tempdir().unwrap();
    let (repo, home, bin) = (
        tmp.path().join("repo"),
        tmp.path().join("home"),
        tmp.path().join("bin"),
    );
    reviewed(&repo);
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&bin).unwrap();
    common::write_executable(&bin.join("codex"), HANGING_CODEX).unwrap();
    let checkout = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let craft = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args([
            "review",
            "run",
            "--backend",
            "codex",
            "--base",
            "origin/main",
        ])
        .args(["--no-gate", "--no-recall", "--depth", "light", "--cwd"])
        .arg(&repo)
        .arg("--host-bin")
        .arg(bin.join("codex"))
        .arg("--craft-root")
        .arg(&checkout)
        .env("HOME", &home)
        .env_remove("CLAUDE_PLUGIN_ROOT")
        .env_remove("CRAFT_ROOT")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    wait_until("a task started", Duration::from_secs(30), || {
        bin.join("pid").exists()
    });
    let sent = Command::new("kill")
        .args(["-TERM", &craft.id().to_string()])
        .status()
        .unwrap();
    assert!(sent.success());
    let out = craft.wait_with_output().unwrap();
    let (stdout, stderr) = (
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
    assert_eq!(out.status.code(), Some(143), "{stdout}\n{stderr}");
    assert!(
        stdout.contains("INCOMPLETE — review run was stopped by a signal (exit 143)"),
        "{stdout}"
    );
    assert!(stdout.contains("To resume it"), "{stdout}");
    for name in ["pid", "grandchild"] {
        let pid = pid_in(&bin, name);
        wait_until(
            &format!("{name} {pid} gone"),
            Duration::from_secs(3),
            || gone(pid),
        );
    }
    let filed = std::fs::read_dir(home.join(".craft/runs"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.to_string_lossy().ends_with("-workflow-review.json"))
        .map(|p| std::fs::read_to_string(p).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(filed.len(), 1, "one record is filed");
    assert!(filed[0].contains("INCOMPLETE"), "{}", filed[0]);
    let record: serde_json::Value = serde_json::from_str(&filed[0]).unwrap();
    assert_eq!(
        record["runtime"],
        serde_json::json!("codex"),
        "the record names the host its tasks ran in, not claude-code"
    );
}
