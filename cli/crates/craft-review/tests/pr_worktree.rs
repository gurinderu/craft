//! A given `pr=` whose head this checkout's `HEAD` does not hold is reviewed in craft's own detached
//! worktree, `<worktrees>/<repo key>/pr-<N>-<head>`, the head fetched from `origin` when the
//! repository lacks it; a clean worktree there from before, at that head, is reused and never
//! moved; a dirty one, one at another `HEAD` or a stranger is refused, and a `HEAD` holding the
//! head lays none. The user's checkout is never touched.
#![expect(
    clippy::unwrap_used,
    reason = "the helpers of these tests fail loudly, like the tests they serve"
)]

mod common;

use std::path::{Path, PathBuf};

use common::git;
use common::pr_gh::{pr, pr_gh, rev};
use craft_review::publish::PostSetup;
use craft_review::step::{self, StartOptions};
use serde_json::Value;

const N: u64 = 7;

/// A fixture on `main` whose PR #7 has its head only on `origin` (`refs/pull/7/head` of a bare
/// repository), and that head.
fn on_trunk(keep: &Path) -> (tempfile::TempDir, String) {
    let repo = common::fixture(true);
    let r = repo.path();
    let origin = keep.join("origin.git");
    git(keep, &["init", "-q", "--bare", origin.to_str().unwrap()]);
    git(r, &["checkout", "-q", "-b", "feature"]);
    std::fs::write(r.join("src/lib.rs"), "pub fn f() -> u8 { 2 }\n").unwrap();
    git(r, &["commit", "-qam", "feat: two"]);
    let head = rev(r, "HEAD");
    git(
        r,
        &[
            "push",
            "-q",
            origin.to_str().unwrap(),
            "feature:refs/pull/7/head",
        ],
    );
    git(r, &["checkout", "-q", "main"]);
    git(r, &["branch", "-qD", "feature"]);
    git(r, &["reflog", "expire", "--expire=now", "--all"]);
    git(r, &["gc", "-q", "--prune=now"]);
    git(r, &["remote", "add", "origin", origin.to_str().unwrap()]);
    assert!(
        !craft_review::git::has_commit(r, &head),
        "the head is origin's only"
    );
    (repo, head)
}

/// Starts `runs/r1` over `repo` with PR #7 given, its worktrees under `worktrees`.
fn start(repo: &Path, runs: &Path, worktrees: &Path, gh: &PostSetup) -> Result<Value, String> {
    start_as("r1", repo, runs, worktrees, gh)
}

/// Starts `runs/<name>` over `repo` with PR #7 given, its worktrees under `worktrees`.
fn start_as(
    name: &str,
    repo: &Path,
    runs: &Path,
    worktrees: &Path,
    gh: &PostSetup,
) -> Result<Value, String> {
    step::start(&StartOptions {
        run_dir: runs.join(name),
        pr: Some(N),
        chain_gh: Some(gh.clone()),
        worktrees: Some(worktrees.to_path_buf()),
        ..common::opts(repo, runs)
    })
    .map_err(|e| e.to_string())
}

/// Where craft lays PR #7's worktree of `repo` at `head` under `worktrees`.
fn place(repo: &Path, worktrees: &Path, head: &str) -> PathBuf {
    let common = craft_review::git::common_dir(repo).unwrap();
    worktrees
        .join(craft_review::project::project_id(&common))
        .join(format!("pr-{N}-{}", head.get(..12).unwrap()))
}

/// A detached worktree of `repo` at `dir` on `at`, laid by hand as an earlier run would have, the
/// PR's head fetched first.
fn laid_before(repo: &Path, dir: &Path, at: &str) {
    git(repo, &["fetch", "-q", "origin", "pull/7/head"]);
    std::fs::create_dir_all(dir.parent().unwrap()).unwrap();
    let path = dir.to_str().unwrap();
    git(repo, &["worktree", "add", "-q", "--detach", path, at]);
}

fn state(run: &Path) -> Value {
    let st = std::fs::read_to_string(run.join("state.json")).unwrap();
    serde_json::from_str(&st).unwrap()
}

/// The user's checkout as it was: on `main`, at `at`, clean.
fn untouched(repo: &Path, at: &str) {
    assert_eq!(rev(repo, "HEAD"), at);
    assert_eq!(craft_review::git::branch(repo).as_deref(), Some("main"));
    assert!(!craft_review::git::dirty(repo).unwrap());
}

#[test]
fn a_pr_head_the_checkout_lacks_is_fetched_and_reviewed_in_a_new_worktree() {
    let (keep, runs, wt) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let (repo, head) = on_trunk(keep.path());
    let at = rev(repo.path(), "HEAD");
    let gh = pr_gh(
        &keep.path().join("gh"),
        "",
        &pr(N, "feature", &head).to_string(),
    );
    let step = start(repo.path(), runs.path(), wt.path(), &gh).unwrap();
    let dir = place(repo.path(), wt.path(), &head).canonicalize().unwrap();
    assert_eq!(rev(&dir, "HEAD"), head, "the worktree is at the PR's head");
    assert_eq!(step["repo"], dir.display().to_string());
    let st = state(&runs.path().join("r1"));
    assert_eq!(
        st["context"]["repo"],
        dir.display().to_string(),
        "a resume reads the worktree"
    );
    assert_eq!(st["chain"]["branch"], "feature");
    let notes = st["notes"].to_string();
    assert!(
        notes.contains(&dir.display().to_string()) && notes.contains("worktree"),
        "{notes}"
    );
    assert_eq!(
        step["worktree"]
            .as_str()
            .map(|l| l.contains(&dir.display().to_string())),
        Some(true),
        "{step}"
    );
    untouched(repo.path(), &at);
}

#[test]
fn a_worktree_from_before_at_the_same_head_is_reused_as_it_is() {
    let (keep, runs, wt) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let (repo, head) = on_trunk(keep.path());
    let at = rev(repo.path(), "HEAD");
    let dir = place(repo.path(), wt.path(), &head);
    laid_before(repo.path(), &dir, &head);
    let gh = pr_gh(
        &keep.path().join("gh"),
        "",
        &pr(N, "feature", &head).to_string(),
    );
    let step = start(repo.path(), runs.path(), wt.path(), &gh).unwrap();
    assert_eq!(
        step["repo"],
        dir.canonicalize().unwrap().display().to_string()
    );
    assert_eq!(rev(&dir, "HEAD"), head);
    let notes = state(&runs.path().join("r1"))["notes"].to_string();
    assert!(notes.contains("reused"), "{notes}");
    untouched(repo.path(), &at);
}

#[test]
fn the_gate_in_crafts_worktree_holds_cargo_to_the_lockfile() {
    let (keep, runs, wt) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let (repo, head) = on_trunk(keep.path());
    let dir = place(repo.path(), wt.path(), &head);
    laid_before(repo.path(), &dir, &head);
    // A package with its lockfile there, as a PR's head would hold them.
    std::fs::write(dir.join("Cargo.toml"), "[package]\nname = \"f\"\n").unwrap();
    std::fs::write(dir.join("Cargo.lock"), "pinned\n").unwrap();
    let tools = keep.path().join("tools");
    std::fs::create_dir_all(&tools).unwrap();
    let calls = tools.join("calls");
    let cargo = format!("#!/bin/sh\necho \"$*\" >> '{}'\n", calls.display());
    common::exe::write_executable(&tools.join("cargo"), &cargo).unwrap();
    let gh = pr_gh(
        &keep.path().join("gh"),
        "",
        &pr(N, "feature", &head).to_string(),
    );
    step::start(&StartOptions {
        run_dir: runs.path().join("r1"),
        pr: Some(N),
        chain_gh: Some(gh),
        worktrees: Some(wt.path().to_path_buf()),
        gate: Some(craft_review::gate::GateSetup {
            path: Some(tools.into_os_string()),
            ..craft_review::gate::GateSetup::default()
        }),
        ..common::opts(repo.path(), runs.path())
    })
    .unwrap();
    let calls = std::fs::read_to_string(calls).unwrap();
    assert!(
        !calls.is_empty() && calls.lines().all(|l| l.contains("--locked")),
        "{calls}"
    );
}

#[test]
fn a_worktree_at_the_same_path_on_another_head_is_refused_and_not_moved() {
    let (keep, runs, wt) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let (repo, head) = on_trunk(keep.path());
    let dir = place(repo.path(), wt.path(), &head);
    laid_before(repo.path(), &dir, "HEAD~1");
    let was = rev(&dir, "HEAD");
    let gh = pr_gh(
        &keep.path().join("gh"),
        "",
        &pr(N, "feature", &head).to_string(),
    );
    let err = start(repo.path(), runs.path(), wt.path(), &gh).unwrap_err();
    assert!(
        err.contains("not the PR's head") && err.contains("git worktree add --detach"),
        "{err}"
    );
    assert_eq!(rev(&dir, "HEAD"), was, "the worktree is not moved");
    assert!(!runs.path().join("r1/state.json").exists());
}

#[test]
fn a_dirty_worktree_from_before_is_refused_and_kept() {
    let (keep, runs, wt) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let (repo, head) = on_trunk(keep.path());
    let dir = place(repo.path(), wt.path(), &head);
    laid_before(repo.path(), &dir, &head);
    std::fs::write(dir.join("README.md"), "someone's edit\n").unwrap();
    let gh = pr_gh(
        &keep.path().join("gh"),
        "",
        &pr(N, "feature", &head).to_string(),
    );
    let err = start(repo.path(), runs.path(), wt.path(), &gh).unwrap_err();
    assert!(
        err.contains("local changes") && err.contains(dir.to_str().unwrap()),
        "{err}"
    );
    assert_eq!(rev(&dir, "HEAD"), head);
    assert_eq!(
        std::fs::read_to_string(dir.join("README.md")).unwrap(),
        "someone's edit\n"
    );
    assert!(
        !runs.path().join("r1/state.json").exists(),
        "a refused run keeps no state"
    );
}

#[test]
fn a_path_there_that_is_no_worktree_of_this_repository_is_refused() {
    let (keep, runs, wt) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let (repo, head) = on_trunk(keep.path());
    let dir = place(repo.path(), wt.path(), &head);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("mine.txt"), "x\n").unwrap();
    let gh = pr_gh(
        &keep.path().join("gh"),
        "",
        &pr(N, "feature", &head).to_string(),
    );
    let err = start(repo.path(), runs.path(), wt.path(), &gh).unwrap_err();
    assert!(
        err.contains("not a worktree of this repository")
            && err.contains("git worktree add --detach"),
        "{err}"
    );
    assert!(dir.join("mine.txt").exists());
}

#[test]
fn a_head_that_cannot_be_fetched_is_refused_with_the_manual_way() {
    let (keep, runs, wt) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let repo = common::fixture(true);
    let gone = "0123456789abcdef0123456789abcdef01234567";
    let gh = pr_gh(
        &keep.path().join("gh"),
        "",
        &pr(N, "feature", gone).to_string(),
    );
    let err = start(repo.path(), runs.path(), wt.path(), &gh).unwrap_err();
    for want in [
        "could not lay its own worktree",
        "does not hold it",
        "git fetch origin pull/7/head",
        "drop `pr=`",
    ] {
        assert!(err.contains(want), "{want} missing from: {err}");
    }
    assert!(!place(repo.path(), wt.path(), gone).exists());
}

#[test]
fn a_head_holding_the_pr_head_lays_no_worktree() {
    let (keep, runs, wt) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let repo = common::fixture(true);
    let head = rev(repo.path(), "HEAD");
    git(repo.path(), &["checkout", "-q", "--detach"]);
    let gh = pr_gh(
        &keep.path().join("gh"),
        "",
        &pr(N, "main", &head).to_string(),
    );
    let step = start(repo.path(), runs.path(), wt.path(), &gh).unwrap();
    let here = repo.path().canonicalize().unwrap();
    assert_eq!(step["repo"], here.display().to_string());
    assert!(step.get("worktree").is_none(), "{step}");
    assert_eq!(
        std::fs::read_dir(wt.path()).unwrap().count(),
        0,
        "no worktree laid"
    );
}

#[test]
fn runs_starting_on_one_head_at_once_lay_one_worktree_and_share_it() {
    let (keep, runs, wt) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let (repo, head) = on_trunk(keep.path());
    let gh = pr_gh(
        &keep.path().join("gh"),
        "",
        &pr(N, "feature", &head).to_string(),
    );
    let names = ["h1", "h2", "h3", "h4"];
    let repos: Vec<Result<Value, String>> = std::thread::scope(|s| {
        let runs = names.map(|name| {
            let gh = gh.clone();
            let (repo, runs, wt) = (repo.path(), runs.path(), wt.path());
            s.spawn(move || start_as(name, repo, runs, wt, &gh))
        });
        runs.into_iter().map(|r| r.join().unwrap()).collect()
    });
    let dir = place(repo.path(), wt.path(), &head).canonicalize().unwrap();
    for step in &repos {
        let step = step.as_ref().unwrap();
        assert_eq!(step["repo"], dir.display().to_string());
    }
    let parent = dir.parent().unwrap();
    let left: Vec<_> = std::fs::read_dir(parent)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(left.len(), 1, "one worktree, no lock left: {left:?}");
    assert_eq!(rev(&dir, "HEAD"), head);
}
