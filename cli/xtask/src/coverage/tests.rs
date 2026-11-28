use std::collections::{BTreeMap, BTreeSet};

use super::{Report, check};
use crate::justfile::Recipe;
use crate::keys::Keys;

fn step(name: &str, body: &str) -> Recipe {
    Recipe {
        name: name.to_owned(),
        params: Vec::new(),
        groups: vec!["gate".to_owned()],
        body: vec![body.to_owned()],
    }
}

fn keys() -> Keys {
    let scripts: BTreeMap<String, String> = [
        ("lint", "eslint ."),
        ("check:skills", "node integrations/shared/check-skills.mjs"),
        ("format", "prettier --write ."),
    ]
    .into_iter()
    .map(|(n, b)| (n.to_owned(), b.to_owned()))
    .collect();
    Keys::new(&scripts).unwrap()
}

fn set(items: &[&str]) -> BTreeSet<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}

const EXCLUDED: &[(&str, &str)] = &[("script:format", "a fix")];

fn steps() -> Vec<Recipe> {
    vec![
        step("lint", "eslint ."),
        step("check-skills", "node integrations/shared/check-skills.mjs"),
    ]
}

fn required() -> BTreeSet<String> {
    set(&[
        "script:lint",
        "script:check:skills",
        "script:format",
        "file:integrations/shared/check-skills.mjs",
        "recipe:lint",
        "recipe:check-skills",
    ])
}

#[test]
fn a_gate_covering_every_named_check_is_clean() {
    let report = check(&required(), EXCLUDED, &steps(), &keys());
    assert_eq!(report, Report::default());
    assert!(report.is_clean());
}

#[test]
fn a_named_check_no_step_runs_is_uncovered() {
    let mut req = required();
    req.insert("file:integrations/shared/check-new.mjs".to_owned());
    req.insert("ci.yml: an unrecognised command: make".to_owned());
    let report = check(&req, EXCLUDED, &steps(), &keys());
    assert_eq!(
        report.uncovered,
        [
            "ci.yml: an unrecognised command: make",
            "file:integrations/shared/check-new.mjs"
        ]
    );
    assert!(!report.is_clean());
}

#[test]
fn a_step_covers_what_the_script_it_runs_names() {
    let gate = vec![
        step("lint", "eslint ."),
        step("skills", "npm run check:skills"),
    ];
    let mut req = required();
    req.remove("recipe:check-skills");
    req.insert("recipe:skills".to_owned());
    assert!(check(&req, EXCLUDED, &gate, &keys()).is_clean());
}

#[test]
fn a_recipe_out_of_the_gate_and_not_excluded_is_uncovered() {
    let mut req = required();
    req.insert("recipe:extra".to_owned());
    assert_eq!(
        check(&req, EXCLUDED, &steps(), &keys()).uncovered,
        ["recipe:extra"]
    );
}

#[test]
fn an_exclusion_naming_no_check_is_stale() {
    let excluded = [("script:format", "a fix"), ("script:gone", "removed")];
    assert_eq!(
        check(&required(), &excluded, &steps(), &keys()).stale,
        ["script:gone"]
    );
}

#[test]
fn a_repeated_step_is_named_and_both_copies_are_redundant() {
    let mut gate = steps();
    gate.push(step("lint", "eslint ."));
    let report = check(&required(), EXCLUDED, &gate, &keys());
    assert_eq!(report.repeated, ["lint"]);
    assert_eq!(report.redundant, ["lint", "lint"]);
}

#[test]
fn a_step_covering_only_itself_or_what_another_covers_is_redundant() {
    let mut gate = steps();
    gate.push(step("again", "eslint ."));
    gate.push(step("noop", "echo hi"));
    let mut req = required();
    req.extend(set(&["recipe:again", "recipe:noop"]));
    let report = check(&req, EXCLUDED, &gate, &keys());
    assert_eq!(report.redundant, ["lint", "again", "noop"]);
    assert!(report.uncovered.is_empty());
}

#[test]
fn an_empty_gate_is_not_clean() {
    let report = check(&BTreeSet::new(), &[], &[], &keys());
    assert!(report.no_steps);
    assert!(!report.is_clean());
}

mod exact;
