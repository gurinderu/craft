//! A run's telemetry lands with no node on the PATH and no plugin root: the binary writes the run
//! store itself (realm @nick/craft, node #539).
#![cfg(unix)]
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

/// A run started in a fresh repository under `tmp`, with no node on the PATH and no plugin root:
/// its run directory, HOME, PATH and the start's output.
fn started(
    tmp: &Path,
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
    std::fs::write(code.join("lib.rs"), "pub fn f() {}\n").unwrap();
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
fn submit(run: &Path, home: &Path, path: &str, extra: &[&str]) -> std::process::Output {
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

#[test]
fn a_run_started_with_no_node_and_no_plugin_root_files_its_start_checkpoint() {
    let tmp = tempfile::tempdir().unwrap();
    let (_, home, _, out) = started(tmp.path());
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

#[test]
fn a_submits_tokens_and_their_scope_are_kept_for_the_runs_record() {
    let tmp = tempfile::tempdir().unwrap();
    let (run, home, path, out) = started(tmp.path());
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let flags = [
        "--output-tokens",
        "1234",
        "--output-tokens-scope",
        "turn-delta",
    ];
    let said = submit(&run, &home, &path, &flags);
    assert!(
        said.status.success(),
        "{}",
        String::from_utf8_lossy(&said.stderr)
    );
    let kept: serde_json::Value =
        serde_json::from_slice(&std::fs::read(run.join("filing.json")).unwrap()).unwrap();
    assert_eq!(
        (&kept["outputTokens"], &kept["outputTokensScope"]),
        (&serde_json::json!(1234), &serde_json::json!("turn-delta")),
        "{kept}"
    );
}

#[test]
fn a_scope_without_its_tokens_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let (run, home, path, _) = started(tmp.path());
    let said = submit(&run, &home, &path, &["--output-tokens-scope", "turn-delta"]);
    assert!(!said.status.success());
    let err = String::from_utf8_lossy(&said.stderr);
    assert!(err.contains("--output-tokens"), "{err}");
}

/// The records filed under `home`'s run store, as text.
fn records(home: &Path) -> Vec<String> {
    let Ok(dir) = std::fs::read_dir(home.join(".craft/runs")) else {
        return Vec::new();
    };
    dir.filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .collect()
}

#[test]
fn a_run_an_earlier_format_wrote_files_its_open_segment_incomplete_then_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let (run, home, path, out) = started(tmp.path());
    assert!(out.status.success());
    // The state as a craft before 0.59.0 left it: format 6.
    let file = run.join("state.json");
    let mut state: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    state["version"] = serde_json::json!(6);
    std::fs::write(&file, state.to_string()).unwrap();
    assert!(records(&home).is_empty());
    let said = submit(&run, &home, &path, &[]);
    assert!(!said.status.success());
    let err = String::from_utf8_lossy(&said.stderr);
    assert!(
        err.contains("a craft before 0.59.0 (format 6)") && err.contains("`craft review start`"),
        "{err}"
    );
    let filed = records(&home);
    assert!(
        filed
            .iter()
            .any(|r| r.contains("\"verdict\": \"INCOMPLETE\"") && r.contains("format 6") && false),
        "{filed:?}"
    );
}
