//! Which change to a runbook buys the runbook lens: a step changed, replaced, disabled or deleted,
//! a shell block's info string flipped, a block nested in a list item — and not a removed line of
//! prose that happens to open with a command.

mod common;

use common::markdown::repo;
use common::{git, ids, opts, prompt_of};
use craft_review::step;
use serde_json::{Value, json};

const DRAIN: &str =
    "# Drain\n\n1. Cordon the node:\n\n    ```sh\n    kubectl cordon $N\n    ```\n\n2. Wait.\n";

fn first_step(before: &str, after: &str) -> Value {
    first_step_over(&[("docs/drain.md", before)], &[("docs/drain.md", after)])
}

#[expect(
    clippy::unwrap_used,
    reason = "a step of the tests, failing loudly like them"
)]
fn first_step_over(before: &[(&str, &str)], after: &[(&str, &str)]) -> Value {
    let repo = repo(before, after);
    let out = tempfile::tempdir().unwrap();
    step::start(&opts(repo.path(), out.path())).unwrap()
}

fn taken(before: &str, after: &str) -> bool {
    let s = first_step(before, after);
    if s.get("verdict") == Some(&json!("Approve (nothing to review)")) {
        return false;
    }
    assert_eq!(ids(&s), ["scout-runbook"], "{s}");
    true
}

#[test]
fn a_step_nested_in_a_list_item_is_a_step() {
    assert!(taken("# Drain\n", DRAIN), "a new list-nested block");
    let flagged = DRAIN.replace("cordon $N", "cordon --dry-run=server $N");
    assert!(taken(DRAIN, &flagged), "a changed command inside it");
}

#[test]
fn a_replaced_disabled_or_deleted_step_is_taken() {
    let replaced = DRAIN.replace("kubectl cordon $N", "./scripts/drain.sh");
    assert!(taken(DRAIN, &replaced), "replaced by a script");
    let disabled = DRAIN.replace("kubectl cordon $N", "# kubectl cordon $N");
    assert!(taken(DRAIN, &disabled), "commented out");
    let deleted = DRAIN.replace("    kubectl cordon $N\n", "");
    assert!(taken(DRAIN, &deleted), "a pure deletion");
}

#[test]
fn a_flipped_info_string_is_taken_either_way() {
    let text = DRAIN.replace("```sh", "```text");
    assert!(taken(DRAIN, &text), "sh to text");
    assert!(taken(&text, DRAIN), "text to sh");
}

#[test]
fn prose_and_a_removed_prose_line_opening_with_a_command_are_not() {
    let before = format!("{DRAIN}\nssh is how we reach the bastion.\n");
    assert!(!taken(&before, DRAIN), "a removed prose line is no step");
    let typo = DRAIN.replace("Wait.", "Wait for it.");
    assert!(!taken(DRAIN, &typo), "a typo beside the steps");
}

#[test]
fn a_deleted_runbook_is_taken() {
    assert!(taken(DRAIN, ""), "every command line removed");
}

#[test]
fn a_step_removed_in_a_rename_is_matched_under_the_old_path_whatever_diff_renames_says() {
    let moved = DRAIN.replace("    kubectl cordon $N\n", "");
    let repo = repo(
        &[("docs/drain.md", DRAIN)],
        &[("docs/drain.md", ""), ("docs/ops/drain.md", &moved)],
    );
    git(repo.path(), &["config", "diff.renames", "false"]);
    let out = tempfile::tempdir().unwrap();
    let s = step::start(&opts(repo.path(), out.path())).unwrap();
    assert_eq!(ids(&s), ["scout-runbook"], "{s}");
    let p = prompt_of(&s["tasks"][0]);
    assert!(
        p.contains("':(literal)docs/ops/drain.md'"),
        "the new path: {p}"
    );
    assert!(
        !p.contains("':(literal)docs/drain.md'"),
        "not the old one: {p}"
    );
}
