//! A given `pr=` names the pull request whose head is `HEAD`: a checkout that does not hold that
//! head — the trunk, an unrelated commit, or one where the head is not even fetched — is refused
//! before any task, saying how to review the PR's head; a tree with local edits on that head, or
//! fix commits on it not yet pushed (noted), is reviewed; gh unreachable, the run goes on as before
//! and says the head went unchecked.
#![expect(
    clippy::unwrap_used,
    reason = "the helpers of these tests fail loudly, like the tests they serve"
)]

mod common;

use std::path::Path;

use common::git;
use common::pr_gh::{calls, detached, pr, pr_gh, rev};
use craft_review::chain;
use craft_review::publish::PostSetup;
use craft_review::step::{self, StartOptions};
use serde_json::{Value, json};

/// Starts `runs/<name>` over `repo` with `pr` given, asking gh through `gh`.
fn start(repo: &Path, runs: &Path, name: &str, gh: &PostSetup, pr: u64) -> Result<Value, String> {
    step::start(&StartOptions {
        run_dir: runs.join(name),
        pr: Some(pr),
        chain_gh: Some(gh.clone()),
        ..common::opts(repo, runs)
    })
    .map_err(|e| e.to_string())
}

fn state(run: &Path) -> Value {
    let st = std::fs::read_to_string(run.join("state.json")).unwrap();
    serde_json::from_str(&st).unwrap()
}

/// What a refused run left: no state, no round record.
fn assert_nothing_filed(run: &Path) {
    assert!(
        !run.join("state.json").exists(),
        "a refused run keeps no state"
    );
    assert!(
        !chain::record_path(run).exists(),
        "a refused run files no round"
    );
}

#[test]
fn a_pr_named_from_a_checkout_on_the_trunk_is_refused_before_any_task() {
    let (keep, runs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let repo = common::fixture(true);
    let at = rev(repo.path(), "HEAD");
    git(repo.path(), &["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.path().join("src/lib.rs"), "pub fn f() -> u8 { 2 }\n").unwrap();
    git(repo.path(), &["commit", "-qam", "feat: two"]);
    let pr_head = rev(repo.path(), "HEAD");
    git(repo.path(), &["checkout", "-q", "main"]);
    let view = pr(1491, "feature", &pr_head).to_string();
    let gh = pr_gh(&keep.path().join("gh"), "", &view);
    let err = start(repo.path(), runs.path(), "r1", &gh, 1491).unwrap_err();
    for want in [
        "pr=1491",
        "PR #1491",
        pr_head.get(..12).unwrap(),
        at.get(..12).unwrap(),
        "gh pr checkout 1491",
        "git fetch origin pull/1491/head && git worktree add --detach ~/.craft/worktrees/<repo>/pr-1491-",
        "never a worktree another session made",
        "drop `pr=`",
    ] {
        assert!(err.contains(want), "{want} missing from: {err}");
    }
    assert!(calls(&keep.path().join("gh")).starts_with("pr view 1491 --json"));
    assert_nothing_filed(&runs.path().join("r1"));
}

#[test]
fn a_head_ahead_of_the_pr_head_is_reviewed_on_its_chain_and_noted() {
    let (keep, runs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let repo = detached(runs.path());
    let pr_head = rev(repo.path(), "HEAD");
    std::fs::write(repo.path().join("src/lib.rs"), "pub fn f() -> u8 { 3 }\n").unwrap();
    git(repo.path(), &["commit", "-qam", "fix: local, not pushed"]);
    let view = pr(1488, "main", &pr_head).to_string();
    let gh = pr_gh(&keep.path().join("gh"), "", &view);
    start(repo.path(), runs.path(), "r2", &gh, 1488).unwrap();
    let st = state(&runs.path().join("r2"));
    assert_eq!(
        (&st["chain"]["branch"], &st["chain"]["round"]),
        (&json!("main"), &json!(2))
    );
    let notes = st["notes"].to_string();
    assert!(
        notes.contains("HEAD is 1 commit ahead of PR #1488's head")
            && notes.contains("push before publishing"),
        "{notes}"
    );
}

/// The refusal of a run over `repo` whose PR #1488 has its head at `pr_head`.
fn refused(repo: &Path, pr_head: &str) {
    let (keep, runs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let view = pr(1488, "main", pr_head).to_string();
    let gh = pr_gh(&keep.path().join("gh"), "", &view);
    let err = start(repo, runs.path(), "r1", &gh, 1488).unwrap_err();
    assert!(
        err.contains("does not hold it") && err.contains("gh pr checkout 1488"),
        "{err}"
    );
    assert_nothing_filed(&runs.path().join("r1"));
}

#[test]
fn a_head_beside_the_pr_head_is_refused() {
    let repo = common::fixture(true);
    let pr_head = rev(repo.path(), "HEAD");
    git(repo.path(), &["checkout", "-q", "--detach", "HEAD~1"]);
    std::fs::write(repo.path().join("other.txt"), "z\n").unwrap();
    git(repo.path(), &["add", "."]);
    git(repo.path(), &["commit", "-qm", "feat: elsewhere"]);
    refused(repo.path(), &pr_head);
}

#[test]
fn a_pr_head_this_repository_lacks_is_refused() {
    let repo = common::fixture(true);
    refused(repo.path(), "0123456789abcdef0123456789abcdef01234567");
}

#[test]
fn local_edits_on_the_pr_head_are_reviewed_on_its_chain() {
    let (keep, runs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let repo = detached(runs.path());
    let head = rev(repo.path(), "HEAD");
    std::fs::write(repo.path().join("src/lib.rs"), "pub fn f() -> u8 { 4 }\n").unwrap();
    let gh = pr_gh(
        &keep.path().join("gh"),
        "",
        &pr(1488, "main", &head).to_string(),
    );
    start(repo.path(), runs.path(), "r2", &gh, 1488).unwrap();
    let st = state(&runs.path().join("r2"));
    assert_eq!(
        (&st["chain"]["branch"], &st["chain"]["round"]),
        (&json!("main"), &json!(2))
    );
}

#[test]
fn gh_unreachable_on_a_branch_reviews_it_and_notes_the_head_went_unchecked() {
    let (keep, runs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let repo = common::fixture(true);
    let dir = keep.path().join("gh");
    let gh = pr_gh(&dir, "", "");
    std::fs::write(dir.join("fail"), "").unwrap();
    start(repo.path(), runs.path(), "r1", &gh, 1491).unwrap();
    let st = state(&runs.path().join("r1"));
    assert_eq!(
        (&st["chain"]["branch"], &st["chain"]["pr"]),
        (&json!("main"), &json!(1491))
    );
    let notes = st["notes"].to_string();
    assert!(
        notes.contains("PR #1491")
            && notes.contains("not checked")
            && notes.contains("Bad credentials"),
        "{notes}"
    );
}
