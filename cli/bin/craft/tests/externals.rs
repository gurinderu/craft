//! `craft init` composition of discovery and import. The command runs with no Node on PATH.
#![expect(
    clippy::unwrap_used,
    reason = "fixture setup and JSON assertions fail loudly"
)]
use serde_json::Value;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Output, Stdio};

fn run(root: &Path, args: &[&str], input: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(args)
        .env("HOME", root.join("home"))
        .env("PATH", root.join("bin"))
        .env_remove("CRAFT_ROOT")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", root.join("no-gitconfig"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

fn value(out: &Output, code: i32) -> Value {
    assert_eq!(
        out.status.code(),
        Some(code),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        out.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}

#[test]
fn init_refuses_a_root_outside_git() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().to_str().unwrap();
    let out = run(t.path(), &["init", "--propose", "--cwd", root], "");
    assert_eq!(out.status.code(), Some(1));
}

#[cfg(unix)]
#[path = "externals/init_native.rs"]
mod init_native;
