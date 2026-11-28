use std::collections::BTreeMap;

use super::{check, summary_mismatch};
use crate::justfile::{self, recipes};
use crate::sources::Repo;

const JUSTFILE: &str =
    "gate *args:\n    cd cli && cargo xtask gate \"$@\"\n\n[group('gate')]\nlint:\n    eslint .\n";

fn repo(justfile: &str, cells: &[&str]) -> Repo {
    let scripts: BTreeMap<String, String> = [("lint", "eslint ."), ("gate", "just gate")]
        .into_iter()
        .map(|(n, b)| (n.to_owned(), b.to_owned()))
        .collect();
    Repo {
        scripts,
        check_files: Vec::new(),
        ci_runs: vec![
            "npm ci".to_owned(),
            "just gate --base \"$BASE_SHA\"".to_owned(),
        ],
        agents_cells: cells.iter().map(|c| (*c).to_owned()).collect(),
        recipes: recipes(justfile),
        ignores_errors: justfile::ignores_errors(justfile),
    }
}

struct Checked {
    passed: bool,
    out: String,
    err: String,
}

const EXCLUDED: &[(&str, &str)] = &[
    ("recipe:gate", "the gate"),
    ("script:gate", "its alias"),
    ("cmd:npm ci", "installs"),
];

fn run(repo: &Repo, summary: &str) -> Checked {
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let passed = check(repo, EXCLUDED, summary, &mut out, &mut err).unwrap();
    Checked {
        passed,
        out: String::from_utf8(out).unwrap(),
        err: String::from_utf8(err).unwrap(),
    }
}

#[test]
fn a_command_cell_naming_a_recipe_nothing_defines_is_uncovered() {
    let c = run(
        &repo(JUSTFILE, &["`just lint`", "`just missing`"]),
        "gate lint",
    );
    assert!(!c.passed);
    assert!(
        c.err
            .contains("gate-steps: not a gate step and not excluded: recipe:missing\n"),
        "{}",
        c.err
    );
}

#[test]
fn a_script_whose_body_no_step_spells_is_uncovered() {
    let drifted = JUSTFILE.replace("eslint .", "eslint src");
    let c = run(&repo(&drifted, &[]), "gate lint");
    assert!(
        c.err
            .contains("gate-steps: not a gate step and not excluded: script:lint\n"),
        "{}",
        c.err
    );
    assert!(!c.passed);
}

#[test]
fn a_recipe_dropped_from_the_gate_group_is_uncovered() {
    let dropped = JUSTFILE.replace("[group('gate')]\n", "");
    let c = run(&repo(&dropped, &[]), "gate lint");
    assert!(
        c.err
            .contains("gate-steps: not a gate step and not excluded: recipe:lint\n"),
        "{}",
        c.err
    );
    assert!(
        c.err
            .contains("gate-steps: the justfile has no recipe in the gate group\n")
    );
}

#[test]
fn a_reader_disagreeing_with_just_fails_the_check() {
    let c = run(&repo(JUSTFILE, &[]), "gate lint hidden");
    assert!(!c.passed);
    assert!(c.err.contains("just lists the recipes"), "{}", c.err);
    assert!(summary_mismatch(&recipes(JUSTFILE), "gate\tlint\n").is_none());
}

#[test]
fn a_complete_gate_passes_and_says_what_it_counted() {
    let c = run(&repo(JUSTFILE, &["`just lint`"]), "gate lint");
    assert!(c.passed, "{}", c.err);
    assert!(c.err.is_empty());
    assert_eq!(
        c.out,
        "gate-steps: 5 named checks, each one of the 1 gate steps or excluded with its reason\n"
    );
}

#[test]
fn an_exclusion_the_repository_does_not_name_fails_the_check() {
    let mut repo = repo(JUSTFILE, &[]);
    repo.ci_runs.retain(|r| r != "npm ci");
    let c = run(&repo, "gate lint");
    assert!(!c.passed);
    assert_eq!(
        c.err,
        "gate-steps: an exclusion naming no check: cmd:npm ci\n"
    );
}

#[test]
fn the_gate_recipe_itself_may_not_hide_the_runner_s_failure() {
    let masked = JUSTFILE.replace("gate \"$@\"\n", "gate \"$@\" || true\n");
    let c = run(&repo(&masked, &["`just lint`"]), "gate lint");
    assert!(!c.passed);
    assert!(
        c.err.starts_with("gate-steps: a gate line whose failure cannot fail its step: gate: cd cli && cargo xtask gate \"$@\" || true — "),
        "{}",
        c.err
    );
}

#[test]
fn a_justfile_ignoring_errors_fails_the_check() {
    let ignoring = format!("set ignore-errors\n\n{JUSTFILE}");
    let c = run(&repo(&ignoring, &["`just lint`"]), "gate lint");
    assert!(!c.passed);
    assert!(c.err.contains("justfile: `set ignore-errors`"), "{}", c.err);
}
