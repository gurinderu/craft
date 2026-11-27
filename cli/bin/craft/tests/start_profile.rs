//! What `review start` takes from its command line and from the reviewer's profile `craft init
//! --write` keeps for the checkout (realm @nick/craft, nodes #644, #634): the profile's `[lenses]`
//! reach the run's composition, `--all-lenses` sets them aside, `--lens-agents` is the rounds'
//! budget. HOME is a temporary directory holding the profile.
#![expect(
    clippy::unwrap_used,
    reason = "the fixture helpers fail the test loudly, like the tests they serve"
)]

use std::path::Path;
use std::process::{Command, Output};

use serde_json::{Value, json};

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

/// A repository whose branch changes `src/lib.rs` over `origin/main`.
fn branch(code: &Path) {
    std::fs::create_dir_all(code.join("src")).unwrap();
    git(code, &["init", "-q", "-b", "main"]);
    std::fs::write(code.join("src/lib.rs"), "pub fn f() -> u8 { 0 }\n").unwrap();
    git(code, &["add", "."]);
    git(code, &["commit", "-qm", "init"]);
    git(code, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    std::fs::write(code.join("src/lib.rs"), "pub fn f() -> u8 { 1 }\n").unwrap();
    git(code, &["commit", "-qam", "feat: f"]);
}

fn craft(home: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(args)
        .env("HOME", home)
        .env("CRAFT_CODE_GRAPH", "")
        .env_remove("CRAFT_ROOT")
        .output()
        .unwrap()
}

/// The state of a run `review start` opened over `code` with `extra`, the profile in `home`.
fn started(home: &Path, code: &Path, extra: &[&str]) -> Value {
    let run = home.join("run");
    let mut args = vec!["review", "start", "--no-recall", "--no-gate", "--cwd"];
    args.extend([code.to_str().unwrap(), "--run-dir", run.to_str().unwrap()]);
    args.extend(extra);
    let out = craft(home, &args);
    assert!(out.status.success(), "{out:?}");
    serde_json::from_str(&std::fs::read_to_string(run.join("state.json")).unwrap()).unwrap()
}

/// A checkout under `t` whose reviewer's profile turns the errors lens off, and the home holding it.
fn profiled(t: &Path) -> (std::path::PathBuf, std::path::PathBuf) {
    let (code, home) = (t.join("repo"), t.join("home"));
    branch(&code);
    let code = std::fs::canonicalize(&code).unwrap();
    let args = ["init", "--write", "--lens", "rust:errors=off", "--cwd"];
    let out = craft(&home, &[&args[..], &[code.to_str().unwrap()]].concat());
    assert!(out.status.success(), "{out:?}");
    (code, home)
}

fn notes(state: &Value) -> String {
    let all = state["notes"].as_array().unwrap().iter();
    all.filter_map(Value::as_str).collect::<Vec<_>>().join("\n")
}

#[test]
fn the_lenses_init_wrote_for_the_checkout_reach_a_review_started_in_it() {
    let tmp = tempfile::tempdir().unwrap();
    let (code, home) = profiled(tmp.path());
    let state = started(&home, &code, &[]);
    assert_eq!(
        state["context"]["composition"]["off"],
        json!(["rust:errors"])
    );
    assert!(
        notes(&state).contains("turned off: rust:errors"),
        "{}",
        notes(&state)
    );
}

#[test]
fn all_lenses_sets_the_profiles_composition_aside_and_says_so() {
    let tmp = tempfile::tempdir().unwrap();
    let (code, home) = profiled(tmp.path());
    let state = started(&home, &code, &["--all-lenses"]);
    assert_eq!(state["context"]["composition"]["off"], Value::Null);
    assert!(
        notes(&state).contains("every lens runs (`--all-lenses`), though"),
        "{}",
        notes(&state)
    );
}

#[test]
fn lens_agents_is_the_budget_the_rounds_keep() {
    let tmp = tempfile::tempdir().unwrap();
    let (code, home) = (tmp.path().join("repo"), tmp.path().join("home"));
    branch(&code);
    let state = started(&home, &code, &["--lens-agents", "4"]);
    assert_eq!(state["rounds"]["budget"], json!(4));
    std::fs::remove_dir_all(home.join("run")).unwrap();
    assert_eq!(started(&home, &code, &[])["rounds"]["budget"], Value::Null);
}
