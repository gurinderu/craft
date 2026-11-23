//! A real run started and submitted through the binary with no node on the PATH and no plugin
//! root, its run store under a HOME of its own.
#![allow(dead_code, reason = "each test crate uses its own part of these")]
#![expect(
    clippy::unwrap_used,
    reason = "the fixture fails the test loudly, like the tests it serves"
)]

use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .status()
        .unwrap();
    assert!(ok.success(), "git {args:?}");
}

/// A directory holding only `git`, for a PATH with no node on it.
fn path_with_git_alone(dir: &Path) -> String {
    let which = Command::new("sh")
        .args(["-c", "command -v git"])
        .output()
        .unwrap();
    let real = String::from_utf8(which.stdout).unwrap();
    std::fs::create_dir_all(dir).unwrap();
    std::os::unix::fs::symlink(real.trim(), dir.join("git")).unwrap();
    dir.display().to_string()
}

/// A run started in a fresh repository under `tmp`, with no node on the PATH and no plugin root:
/// its run directory, HOME, PATH and the start's output.
pub fn started(
    tmp: &Path,
) -> (
    std::path::PathBuf,
    std::path::PathBuf,
    String,
    std::process::Output,
) {
    started_with(tmp, ("lib.rs", "pub fn f() {}\n"))
}

/// [`started`] over a change adding `file` with `text`.
pub fn started_with(
    tmp: &Path,
    (file, text): (&str, &str),
) -> (
    std::path::PathBuf,
    std::path::PathBuf,
    String,
    std::process::Output,
) {
    let (code, run, home) = (tmp.join("repo"), tmp.join("run"), tmp.join("home"));
    std::fs::create_dir_all(&code).unwrap();
    git(&code, &["init", "-q", "-b", "main"]);
    std::fs::write(code.join("README.md"), "x\n").unwrap();
    git(&code, &["add", "."]);
    git(&code, &["commit", "-qm", "init"]);
    git(&code, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    std::fs::write(code.join(file), text).unwrap();
    git(&code, &["add", "."]);
    git(&code, &["commit", "-qm", "f"]);
    let path = path_with_git_alone(&tmp.join("bin"));
    let out = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args([
            "review",
            "start",
            "--no-recall",
            "--no-gate",
            "--record",
            "9.9.9",
            "--cwd",
        ])
        .arg(&code)
        .arg("--run-dir")
        .arg(&run)
        .env("PATH", &path)
        .env("HOME", &home)
        .env_remove("CRAFT_ROOT")
        .env_remove("CLAUDE_PLUGIN_ROOT")
        .env_remove("CLAUDE_CONFIG_DIR")
        .output()
        .unwrap();
    (run, home, path, out)
}

/// `craft review submit` on `run` with `extra` flags, as the engine sends it.
pub fn submit(run: &Path, home: &Path, path: &str, extra: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(["review", "submit", "--run"])
        .arg(run)
        .args(["--agents", "1"])
        .args(extra)
        .env("PATH", path)
        .env("HOME", home)
        .env_remove("CRAFT_ROOT")
        .env_remove("CLAUDE_PLUGIN_ROOT")
        .env_remove("CLAUDE_CONFIG_DIR")
        .output()
        .unwrap()
}

/// `craft review comment` on `run` with `extra` flags.
pub fn comment(run: &Path, home: &Path, path: &str, extra: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(["review", "comment", "--run"])
        .arg(run)
        .args(extra)
        .env("PATH", path)
        .env("HOME", home)
        .env_remove("CRAFT_ROOT")
        .env_remove("CLAUDE_PLUGIN_ROOT")
        .env_remove("CLAUDE_CONFIG_DIR")
        .output()
        .unwrap()
}

/// The records filed under `home`'s run store, as text.
pub fn records(home: &Path) -> Vec<String> {
    let Ok(dir) = std::fs::read_dir(home.join(".craft/runs")) else {
        return Vec::new();
    };
    dir.filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .collect()
}

/// `run`'s state rewritten as format `version` wrote it.
pub fn as_format(run: &Path, version: u32) {
    let file = run.join("state.json");
    let mut state: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    state
        .as_object_mut()
        .unwrap()
        .insert("version".into(), serde_json::json!(version));
    std::fs::write(&file, state.to_string()).unwrap();
}
