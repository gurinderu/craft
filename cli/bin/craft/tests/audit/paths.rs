//! The paths an audit is handed: a given plugin root kept for every later prompt, and a relative
//! run directory made absolute, so the files a step names are found from wherever its agents run.

use std::path::Path;
use std::process::Command;

use serde_json::{Value, json};

use super::{Scratch, ok, scratch};

/// `craft audit <args>` run from `dir`, with no plugin root in the environment.
fn craft_in(s: &Scratch, dir: &Path, args: &[&str]) -> Value {
    let out = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(args)
        .current_dir(dir)
        .env("HOME", &s.home)
        .env_remove("CRAFT_ROOT")
        .output()
        .unwrap();
    ok(&out)
}

fn prompt(task: &Value) -> String {
    std::fs::read_to_string(task["promptFile"].as_str().unwrap()).unwrap()
}

#[test]
fn a_given_plugin_root_wins_over_the_checkout_above_the_binary_and_names_the_later_prompts_skills()
{
    let s = scratch(&["tool.py"]);
    let root = s.home.join("plugin");
    std::fs::create_dir_all(root.join(".claude-plugin")).unwrap();
    std::fs::write(
        root.join(".claude-plugin/plugin.json"),
        r#"{"name":"craft","version":"1.2.3"}"#,
    )
    .unwrap();
    let (repo, run, given) = (
        s.repo.display().to_string(),
        s.run.display().to_string(),
        root.display().to_string(),
    );
    // The built binary sits in this checkout's target/, under its own plugin root.
    let args = [
        "audit",
        "start",
        "--cwd",
        &repo,
        "--run-dir",
        &run,
        "--craft-root",
        &given,
        "--lens-agents",
        "1",
    ];
    let first = craft_in(&s, &s.repo, &args);
    let state: Value =
        serde_json::from_str(&std::fs::read_to_string(s.run.join("state.json")).unwrap()).unwrap();
    assert_eq!(state["args"]["craftRoot"], json!(given), "{state}");
    let skills = format!("`{given}/skills/");
    let at_start = prompt(&first["tasks"][0]);
    assert!(at_start.contains(&skills), "{at_start}");
    let clean = json!({"lens": "l", "findings": []}).to_string();
    std::fs::write(first["tasks"][0]["answerFile"].as_str().unwrap(), clean).unwrap();
    let done = craft_in(&s, &s.repo, &["audit", "submit", "--run", &run]);
    assert_eq!(done["verdict"], "INCOMPLETE", "{done}");
    // The resume's lens prompt is rendered by submit, from the root its state kept.
    let next = craft_in(&s, &s.repo, &["audit", "submit", "--run", &run, "--resume"]);
    let later = prompt(&next["tasks"][0]);
    assert!(
        later.contains(&skills),
        "submit renders with the kept root: {later}"
    );
}

#[test]
fn a_relative_run_directory_and_run_are_made_absolute() {
    let s = scratch(&["tool.py"]);
    let parent = s.run.parent().unwrap().to_owned();
    let repo = s.repo.display().to_string();
    let first = craft_in(
        &s,
        &parent,
        &["audit", "start", "--cwd", &repo, "--run-dir", "run"],
    );
    let file = first["tasks"][0]["promptFile"].as_str().unwrap();
    assert!(Path::new(file).is_absolute(), "{first}");
    assert!(Path::new(file).starts_with(&s.run), "{first}");
    let st = craft_in(&s, &parent, &["audit", "status", "--run", "run"]);
    assert_eq!(st["run"], json!(s.run.display().to_string()), "{st}");
    let next = craft_in(
        &s,
        &parent,
        &["audit", "submit", "--run", "run", "--resume"],
    );
    let again = next["tasks"][0]["promptFile"].as_str().unwrap();
    assert!(Path::new(again).is_absolute(), "{next}");
}
