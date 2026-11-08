//! The plugin root a `craft` binary's prompts name. A released binary is fetched to
//! `~/.craft/bin/<version>/craft`, outside any craft checkout, so looking above itself finds no root;
//! the driver hands it one with `--craft-root`, which wins over that walk and is kept in the run's
//! state, so submit renders its later prompts with the same root.
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the fixture helpers fail the test loudly, like the tests they serve"
)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

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

/// A repository whose `origin/main` is its first commit, with a Rust file added after it.
fn repo(d: &Path) {
    git(d, &["init", "-q", "-b", "main"]);
    std::fs::write(d.join("README.md"), "x\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "init"]);
    git(d, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    std::fs::create_dir_all(d.join("src")).unwrap();
    std::fs::write(d.join("src/lib.rs"), "pub fn f() -> u8 { 1 }\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "feat: add f"]);
}

/// A plugin root as an installed copy holds it: its manifest, naming `version`.
fn plugin(d: &Path, version: &str) {
    std::fs::create_dir_all(d.join(".claude-plugin")).unwrap();
    std::fs::write(
        d.join(".claude-plugin/plugin.json"),
        format!(r#"{{"name":"craft","version":"{version}"}}"#),
    )
    .unwrap();
}

/// The built binary copied to `dir/bin/<v>/craft`, as the fetcher lays it out: no checkout above it.
fn fetched(dir: &Path) -> PathBuf {
    let bin = dir.join("bin/9.9.9/craft");
    std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
    std::fs::copy(env!("CARGO_BIN_EXE_craft"), &bin).unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    bin
}

/// `review start` by `exe` over `repo`, with `root` as `--craft-root` when given, then the scout's
/// answer submitted: the first lens prompt and the context the run's state keeps.
fn start(exe: &Path, repo: &Path, run: &Path, root: Option<&Path>) -> (String, Value) {
    let mut cmd = Command::new(exe);
    cmd.args(["review", "start", "--cwd"])
        .arg(repo)
        .arg("--run-dir")
        .arg(run)
        .env_remove("CRAFT_ROOT");
    if let Some(r) = root {
        cmd.arg("--craft-root").arg(r);
    }
    let out = cmd.output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let step: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(step["tasks"][0]["id"], "scout-rust");
    // The project's memory is recalled beside the scout by default.
    assert_eq!(step["tasks"][1]["id"], "memory-recall");
    // The scout's answer, through the binary, brings the lenses that name the review rules.
    let scout = r#"{"scout-rust": {"sizeBucket": "small", "lenses": ["errors"], "isLibrary": false,
        "securitySensitive": false, "intent": "", "churn": [], "repoRules": [], "notes": ""},
        "memory-recall": {"backend": "none", "why": "no memory configured", "decisions": []}}"#;
    let answers = run.with_extension("answers.json");
    std::fs::write(&answers, scout).unwrap();
    let out = Command::new(exe)
        .args(["review", "submit", "--run"])
        .arg(run)
        .arg("--answers")
        .arg(&answers)
        .env_remove("CRAFT_ROOT")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let step: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(step["tasks"][0]["id"], "lens-rust-errors-r1");
    let prompt = std::fs::read_to_string(step["tasks"][0]["promptFile"].as_str().unwrap()).unwrap();
    let state: Value =
        serde_json::from_str(&std::fs::read_to_string(run.join("state.json")).unwrap()).unwrap();
    (prompt, state["context"].clone())
}

#[test]
fn a_fetched_binary_given_the_root_names_the_real_review_rules() {
    let tmp = tempfile::tempdir().unwrap();
    let (code, root) = (tmp.path().join("repo"), tmp.path().join("plugin"));
    std::fs::create_dir_all(&code).unwrap();
    repo(&code);
    plugin(&root, "1.2.3");
    let exe = fetched(tmp.path());

    let (bare, context) = start(&exe, &code, &tmp.path().join("run-bare"), None);
    assert_eq!(
        context["craftRoot"],
        Value::Null,
        "nothing above the binary"
    );
    assert!(
        bare.contains("`${CLAUDE_PLUGIN_ROOT}/skills/review-rules`.")
            && !bare.contains("plugins/cache"),
        "without a root only the plugin variable is named: {bare}"
    );

    let (given, context) = start(&exe, &code, &tmp.path().join("run"), Some(&root));
    let root = root.display().to_string();
    assert_eq!(
        (&context["craftRoot"], &context["craftVersion"]),
        (&Value::from(root.clone()), &Value::from("1.2.3")),
        "the root and its version are kept in state.json for submit"
    );
    assert!(
        given.contains(&format!("`{root}/skills/review-rules`, `${{CLAUDE_PLUGIN_ROOT}}/skills/review-rules`, `${{CLAUDE_CONFIG_DIR:-$HOME/.claude}}/plugins/cache/craft/craft/1.2.3/skills/review-rules`")),
        "{given}"
    );
}

#[test]
fn the_given_root_wins_over_the_checkout_above_the_binary() {
    let tmp = tempfile::tempdir().unwrap();
    let (code, root) = (tmp.path().join("repo"), tmp.path().join("plugin"));
    std::fs::create_dir_all(&code).unwrap();
    repo(&code);
    plugin(&root, "1.2.3");
    // The built binary sits in this checkout's target/, under its own manifest.
    let exe = Path::new(env!("CARGO_BIN_EXE_craft"));
    let (_, context) = start(exe, &code, &tmp.path().join("run"), Some(&root));
    assert_eq!(
        context["craftRoot"],
        Value::from(root.display().to_string())
    );
}

/// The gate `review start` ran over the fixture, with `extra` arguments, as its state keeps it.
fn gate_of(extra: &[&str]) -> Value {
    let tmp = tempfile::tempdir().unwrap();
    let code = tmp.path().join("repo");
    std::fs::create_dir_all(&code).unwrap();
    repo(&code);
    let run = tmp.path().join("run");
    let out = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(["review", "start", "--no-recall", "--cwd"])
        .arg(&code)
        .arg("--run-dir")
        .arg(&run)
        .args(extra)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let state: Value =
        serde_json::from_str(&std::fs::read_to_string(run.join("state.json")).unwrap()).unwrap();
    state["gate"].clone()
}

#[test]
fn no_gate_runs_no_tool_on_the_branch_and_says_so() {
    let skipped = gate_of(&["--no-gate"]);
    assert!(skipped["tracks"].is_null(), "{skipped}");
    assert!(
        skipped["skipped"].as_str().unwrap().contains("--no-gate"),
        "{skipped}"
    );
    let ran = gate_of(&[]);
    assert_eq!(ran["tracks"][0]["profile"], "rust", "{ran}");
}
