//! What the stopped-run and event-stream tests share: a repository with a Rust change, a stand-in
//! host, a `craft review run` over it, and the pids its stand-ins leave.
#![allow(dead_code, reason = "each test crate uses its own part of these")]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

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

/// A review run's place: its repository, home, and the directory of stand-in tools.
pub struct Bench {
    _tmp: tempfile::TempDir,
    pub repo: PathBuf,
    pub home: PathBuf,
    pub bin: PathBuf,
}

impl Bench {
    pub fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let (repo, home, bin) = (
            tmp.path().join("repo"),
            tmp.path().join("home"),
            tmp.path().join("bin"),
        );
        reviewed(&repo);
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        Self {
            _tmp: tmp,
            repo,
            home,
            bin,
        }
    }

    /// `craft review run --backend codex` over the repository, the stand-in tools first on PATH;
    /// `--no-gate` unless `gate`.
    pub fn review(&self, gate: bool) -> Child {
        self.command("codex", gate)
            .stdin(Stdio::null())
            .spawn()
            .unwrap()
    }

    /// [`Bench::review`] unspawned, the backend named; its stdin is left to the caller, its stdout
    /// and stderr piped for the caller to take or replace.
    pub fn command(&self, backend: &str, gate: bool) -> Command {
        let checkout = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let path = std::env::join_paths(std::iter::once(self.bin.clone()).chain(
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()),
        ))
        .unwrap();
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_craft"));
        // Never the machine's own code graph (realm @nick/craft, node #529).
        cmd.env("CRAFT_CODE_GRAPH", "");
        cmd.args([
            "review",
            "run",
            "--backend",
            backend,
            "--base",
            "origin/main",
        ]);
        if !gate {
            cmd.arg("--no-gate");
        }
        cmd.args(["--no-recall", "--depth", "light", "--cwd"])
            .arg(&self.repo)
            .arg("--host-bin")
            .arg(self.bin.join(backend))
            .arg("--craft-root")
            .arg(&checkout)
            .env("HOME", &self.home)
            .env("PATH", path)
            .env_remove("CLAUDE_PLUGIN_ROOT")
            .env_remove("CRAFT_ROOT")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd
    }

    /// The run records filed under the home.
    pub fn filed(&self) -> Vec<String> {
        std::fs::read_dir(self.home.join(".craft/runs"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.to_string_lossy().ends_with("-workflow-review.json"))
            .map(|p| std::fs::read_to_string(p).unwrap())
            .collect()
    }
}

pub fn pid_in(dir: &Path, name: &str) -> u32 {
    std::fs::read_to_string(dir.join(name))
        .unwrap()
        .trim()
        .parse()
        .unwrap()
}

/// Gone, or a zombie (killed, not yet reaped).
pub fn gone(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat")).map_or(true, |s| {
        s.rsplit(')')
            .next()
            .is_some_and(|rest| rest.trim_start().starts_with('Z'))
    })
}

pub fn wait_until(what: &str, within: Duration, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + within;
    while !done() {
        assert!(Instant::now() < deadline, "{what}: not within {within:?}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Each process `bin/<name>` names gone within a few seconds; one left is killed, then failed on.
pub fn all_gone(bin: &Path, names: &[&str]) {
    for name in names {
        let pid = pid_in(bin, name);
        let deadline = Instant::now() + Duration::from_secs(3);
        while !gone(pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let left = !gone(pid);
        if left {
            // Not left behind by the test, whatever its verdict.
            let _killed = Command::new("kill")
                .args(["-KILL", &pid.to_string()])
                .status();
        }
        assert!(!left, "{name} {pid} outlived the stop");
    }
}

/// Sends `signal` to `child`.
pub fn signal(child: &Child, signal: &str) {
    let sent = Command::new("kill")
        .args([signal, &child.id().to_string()])
        .status()
        .unwrap();
    assert!(sent.success());
}
