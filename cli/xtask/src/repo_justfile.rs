//! The repository's own justfile, run by just itself with `node` and `cargo` replaced by stand-ins that print
//! their arguments: the gate's base reaches the mutation floor's checker, and `just gate`'s arguments reach
//! `cargo xtask gate`. Needs just on the path (the dev shell and CI's rust job have it).
#![cfg(unix)]

use std::fs;
use std::path::Path;
use std::process::{Command, Output};

use crate::gate::takes_base;
use crate::justfile::{self, Recipe};

const FLOOR: &str = "integrations/shared/check-mutation-floor.mjs";

fn repo_recipes() -> Vec<Recipe> {
    justfile::recipes(&fs::read_to_string(crate::root().join("justfile")).unwrap())
}

/// Runs `just <args>` over `justfile` in the repository root, `node` and `cargo` printing their arguments, one a
/// line, and exiting with `exit`.
fn run_just(justfile: &Path, args: &[&str], exit: u8) -> Output {
    let stubs = tempfile::tempdir().unwrap();
    for tool in ["node", "cargo"] {
        let path = stubs.path().join(tool);
        let script = format!("#!/bin/sh\nprintf '%s\\n' {tool} \"$@\"\nexit {exit}\n");
        crate::exe::write_executable(&path, &script).unwrap();
    }
    let path = format!(
        "{}:{}",
        stubs.path().display(),
        std::env::var("PATH").unwrap_or_default()
    );
    Command::new("just")
        .arg("--justfile")
        .arg(justfile)
        .arg("--working-directory")
        .arg(crate::root())
        .args(args)
        .env("PATH", path)
        .output()
        .unwrap_or_else(|e| panic!("just did not start ({e}): these tests need just on the path"))
}

/// `just <args>` over the repository's justfile, its stand-ins succeeding: what they printed.
fn just(args: &[&str]) -> String {
    let ran = run_just(&crate::root().join("justfile"), args, 0);
    assert!(
        ran.status.success(),
        "just {args:?}: {}",
        String::from_utf8_lossy(&ran.stderr)
    );
    String::from_utf8(ran.stdout).unwrap()
}

fn floor_recipe() -> Recipe {
    let found: Vec<Recipe> = repo_recipes()
        .into_iter()
        .filter(|r| r.body_text().contains(FLOOR))
        .collect();
    assert_eq!(found.len(), 1, "one recipe runs {FLOOR}: {found:?}");
    found.into_iter().next().unwrap()
}

#[test]
fn the_mutation_floor_recipe_is_a_gate_step_that_takes_the_base() {
    let floor = floor_recipe();
    assert!(floor.in_group(justfile::GATE_GROUP), "{floor:?}");
    assert!(takes_base(&floor), "{floor:?}");
}

#[test]
fn the_base_reaches_the_mutation_floor_checker_as_one_argument() {
    let name = floor_recipe().name;
    assert_eq!(
        just(&[&name, "abc"]),
        format!("node\n{FLOOR}\n--base\nabc\n")
    );
    assert_eq!(
        just(&[&name, "a b"]),
        format!("node\n{FLOOR}\n--base\na b\n")
    );
    assert_eq!(just(&[&name]), format!("node\n{FLOOR}\n"));
}

#[test]
fn just_gate_hands_its_arguments_to_cargo_xtask_gate() {
    assert_eq!(
        just(&["gate", "--base", "abc"]),
        "cargo\nxtask\ngate\n--base\nabc\n"
    );
    assert_eq!(
        just(&["gate", "--base", "a b"]),
        "cargo\nxtask\ngate\n--base\na b\n"
    );
    assert_eq!(just(&["gate"]), "cargo\nxtask\ngate\n");
}

#[test]
fn just_gate_fails_with_the_runner_s_status() {
    let ran = run_just(&crate::root().join("justfile"), &["gate"], 3);
    assert_eq!(
        ran.status.code(),
        Some(3),
        "{}",
        String::from_utf8_lossy(&ran.stderr)
    );
}

#[test]
fn the_reader_joins_continued_lines_as_just_runs_them() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("justfile");
    let text = "a:\n    echo one\\\n        two  \\\n    three\nb:\n    eslint\\\n    .\nc:\n    eslint \\\n      .\n";
    fs::write(&file, text).unwrap();
    for recipe in justfile::recipes(text) {
        let ran = run_just(&file, &["--dry-run", &recipe.name], 0);
        let printed: Vec<String> = String::from_utf8(ran.stderr)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect();
        assert_eq!(printed, recipe.commands(), "{}", recipe.name);
    }
}
