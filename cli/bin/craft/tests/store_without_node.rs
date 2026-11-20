//! A run's telemetry lands with no node on the PATH and no plugin root: the binary writes the run
//! store itself (realm @nick/craft, node #539).
#![expect(
    clippy::unwrap_used,
    reason = "the fixture fails the test loudly, like the test it serves"
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

#[test]
fn a_run_started_with_no_node_and_no_plugin_root_files_its_start_checkpoint() {
    let tmp = tempfile::tempdir().unwrap();
    let (code, run, home) = (
        tmp.path().join("repo"),
        tmp.path().join("run"),
        tmp.path().join("home"),
    );
    std::fs::create_dir_all(&code).unwrap();
    git(&code, &["init", "-q", "-b", "main"]);
    std::fs::write(code.join("README.md"), "x\n").unwrap();
    git(&code, &["add", "."]);
    git(&code, &["commit", "-qm", "init"]);
    git(&code, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    std::fs::write(code.join("lib.rs"), "pub fn f() {}\n").unwrap();
    git(&code, &["add", "."]);
    git(&code, &["commit", "-qm", "f"]);
    let path = path_with_git_alone(&tmp.path().join("bin"));
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
        .env("PATH", path)
        .env("HOME", &home)
        .env_remove("CRAFT_ROOT")
        .env_remove("CLAUDE_PLUGIN_ROOT")
        .env_remove("CLAUDE_CONFIG_DIR")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let step: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(step["filing"]["lost"], serde_json::json!([]), "{step}");
    let dir = step["filing"]["runDir"].as_str().unwrap();
    assert!(
        dir.starts_with(&home.join(".craft/runs/.partial").display().to_string()),
        "{dir}"
    );
    let slice = std::fs::read_to_string(Path::new(dir).join("00-start.json")).unwrap();
    assert!(slice.contains("\"phase\": \"start\""), "{slice}");
    assert!(slice.contains("\"driver\": \"cli\""), "{slice}");
}
