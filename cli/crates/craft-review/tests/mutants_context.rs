//! The tests lens is told the binary runs the change's mutants only when their worker was launched
//! (realm @nick/craft, node #648): a start whose gate's checks passed — its track passed, or left
//! unknown by a seed tool that did not answer (realm @nick/craft, node #743) — and whose
//! cargo-mutants answers launches it and says so in the lens's prompt; one the reviewer's profile
//! turns them off for does not. cargo and the worker are stand-ins.
#![cfg(unix)]
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the helpers of these tests fail loudly, like the tests they serve"
)]

mod common;

use common::{fixture, git, opts, prompt_of, scout, submit};
use craft_review::gate::GateSetup;
use craft_review::gate::mutants::{BUDGET, MutantsSetup};
use craft_review::step::{self, StartOptions};
use serde_json::{Value, json};

const TOLD: &str = "MUTANTS: the binary runs cargo-mutants";

/// The tests lens's prompt and the run's state, its start's mutants `off` or not, over a
/// repository that keeps semgrep rules for `rules` — never installed here.
fn tests_lens(off: bool, rules: bool) -> (String, Value) {
    let repo = fixture(true);
    // Not committed: the rules are the repository's already, not a part of the change.
    if rules {
        std::fs::create_dir(repo.path().join(".semgrep")).unwrap();
    }
    std::fs::write(
        repo.path().join("Cargo.toml"),
        "[package]\nname = \"f\"\nversion = \"0.1.0\"\n",
    )
    .unwrap();
    git(repo.path(), &["add", "."]);
    git(repo.path(), &["commit", "-qm", "chore: the package"]);
    let (out, tools) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let tool = |name: &str, script: &str| {
        let path = tools.path().join(name);
        common::exe::write_executable(&path, script).unwrap();
        path
    };
    let cargo = tool(
        "cargo",
        "#!/bin/sh\n[ \"$1 $2\" = 'mutants --version' ] && { echo 'cargo-mutants 27.1.0'; exit 0; }\nexit 0\n",
    );
    let worker = tool("worker", "#!/bin/sh\nexit 0\n");
    let run = out.path().join("run");
    step::start(&StartOptions {
        gate: Some(GateSetup {
            path: Some(tools.path().as_os_str().to_owned()),
            ..GateSetup::default()
        }),
        mutants: Some(MutantsSetup {
            exe: worker,
            budget: BUDGET,
            off,
            cargo: cargo.display().to_string(),
            nix: "nix".into(),
            note: String::new(),
        }),
        ..opts(repo.path(), out.path())
    })
    .unwrap();
    let s = submit(&run, json!({"scout-rust": scout("small", &["errors"])}));
    let mut tasks = s["tasks"].as_array().unwrap().iter();
    let tests = tasks.find(|t| t["id"] == "lens-rust-tests-r1");
    let state = std::fs::read_to_string(run.join("state.json")).unwrap();
    (
        prompt_of(tests.unwrap()),
        serde_json::from_str(&state).unwrap(),
    )
}

fn launched(state: &Value) -> bool {
    state["gate"]["mutants"]["dir"]
        .as_str()
        .is_some_and(|d| !d.is_empty())
}

#[test]
fn a_launched_worker_tells_the_tests_lens_the_mutants_run() {
    let (prompt, state) = tests_lens(false, false);
    assert!(launched(&state), "{}", state["notes"]);
    assert!(prompt.contains(TOLD), "{prompt}");
}

/// A seed tool the review asked for and that did not answer leaves the gate's track unknown and
/// the verdict capped (realm @nick/craft, node #743), and the mutants still launch: the checks
/// passed, so the change's tests are known to build.
#[test]
fn a_silent_seed_tool_leaves_the_track_unknown_and_the_mutants_still_launch() {
    let (prompt, state) = tests_lens(false, true);
    let track = &state["gate"]["tracks"][0];
    assert_eq!(track["status"], "unknown", "{state}");
    assert_eq!(track["checksPassed"], true, "{state}");
    assert_eq!(
        track["unanswered"],
        json!(["semgrep is not installed"]),
        "{state}"
    );
    assert!(launched(&state), "{}", state["notes"]);
    assert!(prompt.contains(TOLD), "{prompt}");
}

#[test]
fn no_worker_launched_tells_the_tests_lens_nothing_of_them() {
    let (prompt, state) = tests_lens(true, false);
    assert!(!launched(&state), "{}", state["notes"]);
    assert!(!prompt.contains(TOLD), "{prompt}");
}
