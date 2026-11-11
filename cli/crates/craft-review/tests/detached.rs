//! A run on a detached `HEAD` keys its round chain on the head branch of the pull request that
//! `HEAD` heads, so a detached worktree of a PR chains with the runs of its branch; with no such PR,
//! several, or no answer from gh, it stays round 1 and says why.
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the helpers of these tests fail loudly, like the tests they serve"
)]

mod common;

use std::path::Path;

use common::git;
use common::pr_gh::{calls, detached, pr, pr_gh, rev, to_end};
use craft_review::chain;
use craft_review::publish::PostSetup;
use craft_review::step::{self, StartOptions};
use serde_json::{Value, json};

/// Starts `runs/<name>` over `repo` asking gh through `gh`, with `pr` given: the first step, and
/// the chain the run's state keeps.
fn start(repo: &Path, runs: &Path, name: &str, gh: &PostSetup, pr: Option<u64>) -> (Value, Value) {
    let s = step::start(&StartOptions {
        run_dir: runs.join(name),
        pr,
        chain_gh: Some(gh.clone()),
        ..common::opts(repo, runs)
    })
    .unwrap();
    let st = std::fs::read_to_string(runs.join(name).join("state.json")).unwrap();
    let st: Value = serde_json::from_str(&st).unwrap();
    (s, st["chain"].clone())
}

#[test]
fn a_detached_head_one_pr_heads_chains_with_the_round_of_its_branch() {
    let (keep, runs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let repo = detached(runs.path());
    let head = rev(repo.path(), "HEAD");
    let list = json!([pr(1488, "main", &head), pr(1500, "other", "0123abcd")]);
    let gh = pr_gh(&keep.path().join("gh"), &list.to_string(), "");
    let (s, c) = start(repo.path(), runs.path(), "r2", &gh, None);
    assert_eq!((&c["branch"], &c["round"]), (&json!("main"), &json!(2)));
    let from = "chain branch `main` from PR #1488 (detached HEAD)";
    assert_eq!(c["branchFrom"], json!(from));
    let asked = calls(&keep.path().join("gh"));
    let want = format!(
        "pr list --search {head} --state open --json number,headRefName,headRefOid,isCrossRepository,headRepositoryOwner"
    );
    assert!(asked.contains(&want), "{asked}");

    let run = runs.path().join("r2");
    let report = common::post::report(&to_end(&run, s));
    assert!(
        report.contains("round 2 of this branch") && report.contains(from),
        "{report}"
    );
    let filed: Value =
        serde_json::from_str(&std::fs::read_to_string(chain::record_path(&run)).unwrap()).unwrap();
    assert_eq!(filed["branch"], json!("main"));
}

#[test]
fn a_detached_head_no_pr_heads_is_round_one_and_says_why() {
    let (keep, runs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let repo = detached(runs.path());
    let gh = pr_gh(&keep.path().join("gh"), "[]", "");
    let (_, c) = start(repo.path(), runs.path(), "r2", &gh, None);
    assert_eq!((&c["branch"], &c["round"]), (&Value::Null, &json!(1)));
    let why = c["unchained"].as_str().unwrap();
    assert!(
        why.starts_with("no branch (a detached HEAD) and no pull request named one"),
        "{why}"
    );
    assert!(why.contains("name its pull request (`pr=`)"), "{why}");
    assert!(why.contains("no open pull request has this HEAD"), "{why}");
}

#[test]
fn a_pr_at_another_head_is_not_taken_nor_one_of_several() {
    let (keep, runs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let repo = detached(runs.path());
    let head = rev(repo.path(), "HEAD");
    let other = rev(repo.path(), "HEAD~1");
    let gh = pr_gh(
        &keep.path().join("gh"),
        &json!([pr(1488, "main", &other)]).to_string(),
        "",
    );
    let (_, c) = start(repo.path(), runs.path(), "r2", &gh, None);
    assert_eq!((&c["branch"], &c["round"]), (&Value::Null, &json!(1)));
    let why = c["unchained"].as_str().unwrap();
    assert!(why.contains("no open pull request has this HEAD"), "{why}");

    let two = json!([pr(1488, "main", &head), pr(1490, "copy", &head)]);
    let gh = pr_gh(&keep.path().join("gh2"), &two.to_string(), "");
    let (_, c) = start(repo.path(), runs.path(), "r3", &gh, None);
    assert_eq!(c["branch"], Value::Null);
    let why = c["unchained"].as_str().unwrap();
    assert!(why.contains("2 open pull requests (#1488, #1490)"), "{why}");
}

#[test]
fn a_given_pr_names_the_chain_without_a_search() {
    let (keep, runs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let repo = detached(runs.path());
    let head = rev(repo.path(), "HEAD");
    let gh = pr_gh(
        &keep.path().join("gh"),
        "",
        &pr(1488, "main", &head).to_string(),
    );
    let (_, c) = start(repo.path(), runs.path(), "r2", &gh, Some(1488));
    assert_eq!((&c["branch"], &c["round"]), (&json!("main"), &json!(2)));
    assert_eq!(
        c["branchFrom"],
        json!("chain branch `main` from PR #1488 (pr=1488, detached HEAD)")
    );
    let asked = calls(&keep.path().join("gh"));
    assert!(
        asked.starts_with("pr view 1488 --json") && !asked.contains("pr list"),
        "{asked}"
    );
}

#[test]
fn gh_failing_keeps_the_detached_run_unchained_and_a_branch_never_asks() {
    let (keep, runs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let repo = detached(runs.path());
    let dir = keep.path().join("gh");
    let gh = pr_gh(&dir, "[]", "");
    std::fs::write(dir.join("fail"), "").unwrap();
    let (_, c) = start(repo.path(), runs.path(), "r2", &gh, None);
    assert_eq!((&c["branch"], &c["round"]), (&Value::Null, &json!(1)));
    let why = c["unchained"].as_str().unwrap();
    assert!(
        why.contains("gh could not tell") && why.contains("Bad credentials"),
        "{why}"
    );

    std::fs::remove_file(dir.join("calls")).unwrap();
    git(repo.path(), &["checkout", "-q", "main"]);
    // No PR given, a checked-out branch is asked of no PR: given one, its head is checked (pr_head.rs).
    let (_, c) = start(repo.path(), runs.path(), "r3", &gh, None);
    assert_eq!((&c["branch"], &c["round"]), (&json!("main"), &json!(2)));
    assert_eq!(c["branchFrom"], Value::Null);
    assert_eq!(calls(&dir), "");
}
