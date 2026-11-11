//! The pull request a detached `HEAD`'s chain came from: a fork's PR keys its chain on
//! `<owner>:<head branch>`, which no local branch can be named, so it never joins a local branch's
//! rounds; and a run asked to comment, or published after the fact, publishes on that PR, a given
//! `pr=` winning.
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the helpers of these tests fail loudly, like the tests they serve"
)]

mod common;

use std::path::Path;

use common::post::{answers, found, stand_in};
use common::pr_gh::{calls, detached, fork_pr, pr, pr_gh, rev, to_end};
use craft_review::publish::PostSetup;
use craft_review::step::{self, Said, StartOptions};
use serde_json::{Value, json};

/// Starts `runs/<name>` over `repo` asking gh through `gh`, with `pr` given and `comment` asked.
fn begin(repo: &Path, runs: &Path, name: &str, gh: &PostSetup, ask: (Option<u64>, bool)) -> Value {
    step::start(&StartOptions {
        run_dir: runs.join(name),
        pr: ask.0,
        comment: ask.1,
        chain_gh: Some(gh.clone()),
        ..common::opts(repo, runs)
    })
    .unwrap()
}

fn chain(run: &Path) -> Value {
    let st = std::fs::read_to_string(run.join("state.json")).unwrap();
    serde_json::from_str::<Value>(&st).unwrap()["chain"].clone()
}

#[test]
fn a_fork_pr_headed_main_does_not_chain_with_the_local_main_and_chains_with_itself() {
    let (keep, runs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let repo = detached(runs.path());
    let head = rev(repo.path(), "HEAD");
    let list = json!([fork_pr(9, "alice", "main", &head)]).to_string();
    let gh = pr_gh(&keep.path().join("gh"), &list, "");
    let s = begin(repo.path(), runs.path(), "r2", &gh, (None, false));
    let c = chain(&runs.path().join("r2"));
    assert_eq!(
        (&c["branch"], &c["round"]),
        (&json!("alice:main"), &json!(1))
    );
    let from = "chain branch `alice:main` from PR #9 (detached HEAD)";
    assert_eq!((&c["branchFrom"], &c["pr"]), (&json!(from), &json!(9)));
    let report = common::post::report(&to_end(&runs.path().join("r2"), s));
    assert!(report.contains(from), "{report}");

    begin(repo.path(), runs.path(), "r3", &gh, (None, false));
    let c = chain(&runs.path().join("r3"));
    assert_eq!(
        (&c["branch"], &c["round"]),
        (&json!("alice:main"), &json!(2))
    );
    let prior = c["prior"]["dir"].as_str().unwrap();
    assert!(prior.ends_with("r2"), "{prior}");
}

#[test]
fn a_fork_pr_gh_names_no_owner_of_chains_nothing() {
    let (keep, runs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let repo = detached(runs.path());
    let mut p = fork_pr(9, "alice", "main", &rev(repo.path(), "HEAD"));
    p["headRepositoryOwner"] = Value::Null;
    let gh = pr_gh(&keep.path().join("gh"), &json!([p]).to_string(), "");
    begin(repo.path(), runs.path(), "r2", &gh, (None, false));
    let c = chain(&runs.path().join("r2"));
    assert_eq!((&c["branch"], &c["round"]), (&Value::Null, &json!(1)));
    let why = c["unchained"].as_str().unwrap();
    assert!(why.contains("no owner of the fork"), "{why}");
}

/// Drives the run in `runs/<name>`, its first step `s`, to its end, posting through `post`.
fn commented(runs: &Path, name: &str, mut s: Value, post: &PostSetup) -> Value {
    let said = Said {
        post: Some(post),
        ..Said::default()
    };
    let run = runs.join(name);
    while s["done"] != json!(true) {
        s = step::submit_with(&run, Some(&answers(&s, &found())), &said).unwrap();
    }
    s
}

#[test]
fn a_detached_run_asked_to_comment_posts_on_the_pr_that_named_its_chain() {
    let (keep, runs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let repo = detached(runs.path());
    let head = rev(repo.path(), "HEAD");
    let list = json!([pr(1488, "main", &head)]).to_string();
    let gh = pr_gh(&keep.path().join("gh"), &list, "");
    let post = stand_in(&keep.path().join("post"), &head);
    let s = begin(repo.path(), runs.path(), "r2", &gh, (None, true));
    let s = commented(runs.path(), "r2", s, &post);
    assert_eq!(s["prComments"]["posted"], json!(1), "{s}");
    let asked = calls(&keep.path().join("post"));
    assert!(asked.starts_with("pr view 1488 --json"), "{asked}");
}

#[test]
fn a_given_pr_is_posted_on_whatever_names_the_chain() {
    let (keep, runs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let repo = common::fixture(true);
    let head = rev(repo.path(), "HEAD");
    let gh = pr_gh(&keep.path().join("gh"), "[]", "");
    let post = stand_in(&keep.path().join("post"), &head);
    let s = begin(repo.path(), runs.path(), "r1", &gh, (Some(1500), true));
    assert_eq!(chain(&runs.path().join("r1"))["branch"], json!("main"));
    commented(runs.path(), "r1", s, &post);
    let asked = calls(&keep.path().join("post"));
    assert!(asked.starts_with("pr view 1500 --json"), "{asked}");
}

#[test]
fn a_detached_run_published_after_the_fact_posts_on_the_pr_that_named_its_chain() {
    let (keep, runs) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let repo = detached(runs.path());
    let head = rev(repo.path(), "HEAD");
    let list = json!([pr(1488, "main", &head)]).to_string();
    let gh = pr_gh(&keep.path().join("gh"), &list, "");
    let post = stand_in(&keep.path().join("post"), &head);
    let s = begin(repo.path(), runs.path(), "r2", &gh, (None, false));
    commented(runs.path(), "r2", s, &post);
    assert_eq!(
        calls(&keep.path().join("post")),
        "",
        "nothing posted while it ran"
    );
    let s = craft_review::publish::comment(&runs.path().join("r2"), None, &post).unwrap();
    assert_eq!(s["prComments"]["posted"], json!(1), "{s}");
    let asked = calls(&keep.path().join("post"));
    assert!(asked.starts_with("pr view 1488 --json"), "{asked}");
}
