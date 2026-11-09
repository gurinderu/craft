//! `craft init` and the CI map (realm @nick/craft, nodes #482 and #483): `--propose` prints the
//! workflows' candidates, resolved with the `--ci` that writes each, and a recipe call unresolved;
//! `--write --ci` records a confirmed entry with its workflow's hash, refuses a bare check name,
//! and the next proposal shows what it holds. HOME is a temporary directory.
#![expect(
    clippy::unwrap_used,
    reason = "the fixture helpers fail the test loudly, like the tests they serve"
)]

use std::path::Path;
use std::process::{Command, Output};

use serde_json::Value;

const WORKFLOW: &str = "jobs:
  rust:
    name: Rust
    steps:
      - run: cargo clippy --all-targets -- -D warnings
  lint:
    steps:
      - run: just lint
";

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

fn craft(t: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(args)
        .env("HOME", t.join("home"))
        .env_remove("CRAFT_ROOT")
        .output()
        .unwrap()
}

fn json_of(out: &Output) -> Value {
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "{err}");
    serde_json::from_slice(&out.stdout).unwrap()
}

#[test]
fn the_ci_map_is_proposed_from_the_workflows_written_as_confirmed_and_proposed_again() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    std::fs::create_dir_all(repo.join(".github/workflows")).unwrap();
    std::fs::write(repo.join(".github/workflows/ci.yml"), WORKFLOW).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    let r = repo.display().to_string();
    let t = tmp.path();
    let first = json_of(&craft(t, &["init", "--propose", "--cwd", &r]));
    let found = &first["ciCandidates"];
    assert_eq!(found["resolved"].as_array().unwrap().len(), 1, "{found}");
    let clippy = &found["resolved"][0];
    assert_eq!(
        (&clippy["check"], &clippy["signal"]),
        (&"Rust".into(), &"clippy".into())
    );
    assert_eq!(
        found["unresolved"][0]["runs"],
        serde_json::json!(["just lint"])
    );
    assert_eq!(
        found["unresolved"][0]["workflow"],
        ".github/workflows/ci.yml"
    );

    let ci = clippy["ci"].as_str().unwrap();
    let wrote = json_of(&craft(t, &["init", "--write", "--cwd", &r, "--ci", ci]));
    assert_eq!(wrote["ci"][0]["workflow_hash"].as_str().unwrap().len(), 64);
    let again = json_of(&craft(t, &["init", "--propose", "--cwd", &r]));
    assert_eq!(again["ci"], wrote["ci"]);

    let bare = r#"{"check":"lint","signal":"clippy","command":"just lint","workflow":".github/workflows/ci.yml"}"#;
    let refused = craft(t, &["init", "--write", "--cwd", &r, "--ci", bare]);
    assert!(!refused.status.success());
    assert!(String::from_utf8_lossy(&refused.stderr).contains("does not run `cargo clippy`"));
    let kept = json_of(&craft(t, &["init", "--propose", "--cwd", &r]));
    assert_eq!(kept["ci"], wrote["ci"], "nothing written");
}
