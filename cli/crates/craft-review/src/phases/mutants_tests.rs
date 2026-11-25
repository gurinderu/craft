//! The rounds' end joins the mutants that ran beside them (realm @nick/craft, node #648): each
//! survivor in a touched function reaches the pool before the dedup, and the run says what came
//! of them.

use serde_json::json;

use crate::profile::Profile;
use crate::state::{RunState, STATE_VERSION};

fn git(dir: &std::path::Path, args: &[&str]) {
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

/// A run at its rounds' end whose mutants' worker in `run/mutants` already wrote its result: one
/// mutant of `big`, the function the change touched, survived.
fn run_at_rounds_end(top: &std::path::Path, run: &std::path::Path) -> RunState {
    let dir = run.join("mutants");
    std::fs::create_dir_all(dir.join("mutants.out")).unwrap();
    std::fs::write(dir.join("result.json"), r#"{"ran":"exited","code":2}"#).unwrap();
    std::fs::write(
        dir.join("mutants.out/outcomes.json"),
        r#"{"outcomes":[{"scenario":"Baseline","summary":"Success"},{"scenario":{"Mutant":{"name":"src/lib.rs:1:30: replace >= with < in big","file":"src/lib.rs","function":{"function_name":"big","span":{"start":{"line":1,"column":1},"end":{"line":1,"column":40}}},"span":{"start":{"line":1,"column":30},"end":{"line":1,"column":32}},"genre":"BinaryOperator"}},"summary":"MissedMutant"}],"total_mutants":1,"end_time":"t"}"#,
    )
    .unwrap();
    serde_json::from_value(json!({
        "version": STATE_VERSION,
        "context": {"repo": top.display().to_string(), "base": "HEAD~1", "spec": "", "craftRoot": null, "craftVersion": null, "mutants": true},
        "diff": {"base": "HEAD~1", "mergeBase": "HEAD~1", "head": "HEAD", "dirty": false,
                 "files": ["src/lib.rs"], "stat": "", "log": ""},
        "tracks": [], "light": false, "phase": "lenses", "tasks": [],
        "rounds": {"round": 1, "pool": [], "yields": [], "expected": [], "returned": [], "failures": {}},
        "findings": [], "settled": [], "notes": [], "notRun": [],
        "gate": {"mutants": {"dir": dir.display().to_string(), "top": top.display().to_string(), "base": "HEAD~1"}}
    }))
    .unwrap()
}

#[test]
fn the_rounds_end_pools_the_survivors_and_says_what_came_of_the_mutants() {
    let (top, run) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let d = top.path();
    git(d, &["init", "-q", "-b", "main"]);
    std::fs::create_dir(d.join("src")).unwrap();
    std::fs::write(
        d.join("src/lib.rs"),
        "pub fn big(x: i32) -> bool { x > 10 }\n",
    )
    .unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "init"]);
    std::fs::write(
        d.join("src/lib.rs"),
        "pub fn big(x: i32) -> bool { x >= 10 }\n",
    )
    .unwrap();
    git(d, &["commit", "-qam", "feat: big"]);
    let mut state = run_at_rounds_end(d, run.path());
    let profiles = Profile::all().unwrap();
    super::end_rounds(run.path(), &mut state, &profiles).unwrap();
    let pooled = state
        .rounds
        .pool
        .iter()
        .any(|f| f["toolRule"] == "cargo-mutants::BinaryOperator");
    assert!(pooled, "{:?}", state.rounds.pool);
    let said = state.notes.join("\n");
    assert!(
        said.contains("mutants of the change: 1 survived of 1 tested"),
        "{said}"
    );
    assert!(!state.gate.mutants.running(), "joined once");
}
