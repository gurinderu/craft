//! A renamed runbook: bought by a step its rename removed, whatever `diff.renames` says; handed to
//! its lens at both paths, never in a directory slice that holds only the new one; and counted
//! once, at its new path.

mod common;

use common::markdown::repo;
use common::{git, ids, opts, prompt_of, scout, submit};
use craft_review::step;
use serde_json::json;

/// A runbook numbered `i`, whose step `kubectl cordon node-<i>` the rename removes.
fn runbook(i: usize) -> (String, String) {
    let before = format!(
        "# Drain node {i}\n\n1. Cordon the node:\n\n    ```sh\n    kubectl cordon node-{i}\n    kubectl get node node-{i}\n    ```\n\n2. Wait for node {i}.\n"
    );
    let after = before.replace(&format!("    kubectl cordon node-{i}\n"), "");
    (before, after)
}

#[test]
fn a_step_removed_in_a_rename_reaches_the_lens_at_both_paths_and_counts_once() {
    let (before, after) = runbook(0);
    let repo = repo(
        &[("docs/drain.md", &before)],
        &[("docs/drain.md", ""), ("docs/ops/drain.md", &after)],
    );
    git(repo.path(), &["config", "diff.renames", "false"]);
    let out = tempfile::tempdir().unwrap();
    let s = step::start(&opts(repo.path(), out.path())).unwrap();
    assert_eq!(ids(&s), ["scout-runbook"], "{s}");
    let run = out.path().join("run");
    let status = craft_review::status::status(&run).unwrap();
    assert_eq!(
        status["profiles"][0]["files"],
        json!(1),
        "counted once: {status}"
    );
    let s = submit(&run, json!({"scout-runbook": scout("small", &[])}));
    assert_eq!(ids(&s), ["lens-runbook-runbook-r1"], "{s}");
    let p = prompt_of(&s["tasks"][0]);
    assert!(
        p.contains("-- ':(literal)docs/ops/drain.md' ':(literal)docs/drain.md'"),
        "both paths: {p}"
    );
}

#[test]
fn many_renamed_runbooks_across_directories_reach_one_unsliced_lens_holding_their_old_paths() {
    let texts: Vec<(String, String, String, String)> = (0..12)
        .map(|i| {
            let dir = if i % 2 == 0 { "a" } else { "b" };
            let (before, after) = runbook(i);
            (
                format!("ops/{dir}/r{i}.md"),
                before,
                format!("runbooks/{dir}/r{i}.md"),
                after,
            )
        })
        .collect();
    let before: Vec<(&str, &str)> = texts.iter().map(|t| (t.0.as_str(), t.1.as_str())).collect();
    let mut after: Vec<(&str, &str)> = texts.iter().map(|t| (t.0.as_str(), "")).collect();
    after.extend(texts.iter().map(|t| (t.2.as_str(), t.3.as_str())));
    let repo = repo(&before, &after);
    let out = tempfile::tempdir().unwrap();
    let s = step::start(&opts(repo.path(), out.path())).unwrap();
    assert_eq!(ids(&s), ["scout-runbook"], "{s}");
    let s = submit(
        &out.path().join("run"),
        json!({"scout-runbook": scout("medium", &[])}),
    );
    assert_eq!(
        ids(&s),
        ["lens-runbook-runbook-r1"],
        "one lens task, not one per slice: {s}"
    );
    let p = prompt_of(&s["tasks"][0]);
    for t in &texts {
        assert!(
            p.contains(&format!("':(literal){}'", t.0)),
            "old path {}: {p}",
            t.0
        );
    }
}
