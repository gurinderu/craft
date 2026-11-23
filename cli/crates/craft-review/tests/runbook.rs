//! A changed Markdown runbook — a shell block or a numbered step running a command against an
//! external system — goes to the runbook profile and its lens; prose and project configuration do
//! not, whatever commands they hold.

mod common;

use std::path::Path;

use common::{git, ids, opts, prompt_of, scout, submit};
use craft_review::step;
use serde_json::{Value, json};

const STEPS: &str = "# Recover OVN\n\n1. Find the leader.\n\n```sh\nkubectl -n kube-system get pods -l app=ovn-central\nkubectl -n kube-system delete pod ovn-central-0\n```\n";

/// A repository whose `origin/main` is its first commit, with `files` added after it.
#[expect(
    clippy::unwrap_used,
    reason = "a step of the tests, failing loudly like them"
)]
fn repo_holding(files: &[(&str, &str)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    git(d, &["init", "-q", "-b", "main"]);
    std::fs::write(d.join("LICENSE"), "x\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "init"]);
    git(d, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    for (f, text) in files {
        let path = d.join(f);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "docs: the OVN recovery runbook"]);
    dir
}

#[expect(
    clippy::unwrap_used,
    reason = "a step of the tests, failing loudly like them"
)]
fn start(repo: &Path, out: &Path) -> Value {
    step::start(&opts(repo, out)).unwrap()
}

#[test]
fn a_runbook_goes_to_the_runbook_lens_and_prose_beside_it_does_not() {
    let repo = repo_holding(&[
        ("docs/ovn-recovery.md", STEPS),
        ("README.md", "# Project\n\nWe run kubectl in production.\n"),
    ]);
    let out = tempfile::tempdir().unwrap();
    let s = start(repo.path(), out.path());
    assert_eq!(ids(&s), ["scout-runbook"], "{s}");
    let p = prompt_of(&s["tasks"][0]);
    assert!(
        p.contains("You are scouting a Markdown runbook diff"),
        "{p}"
    );
    assert!(p.contains("':(literal)docs/ovn-recovery.md'"), "{p}");
    assert!(!p.contains("README.md"), "prose is no runbook: {p}");

    let s = submit(
        &out.path().join("run"),
        json!({"scout-runbook": scout("small", &["runbook"])}),
    );
    assert_eq!(ids(&s), ["lens-runbook-runbook-r1"], "{s}");
    let p = prompt_of(&s["tasks"][0]);
    assert!(
        p.contains("You are the **runbook** review lens for a Markdown runbook diff"),
        "{p}"
    );
    assert!(p.contains("Walk the changed steps IN ORDER"), "{p}");
}

#[test]
fn prose_and_a_runbook_kept_as_project_configuration_are_not_reviewed() {
    let repo = repo_holding(&[
        ("README.md", "# Project\n\n```rust\nfn main() {}\n```\n"),
        (".github/RELEASE.md", STEPS),
    ]);
    let out = tempfile::tempdir().unwrap();
    let s = start(repo.path(), out.path());
    assert_eq!(s["verdict"], json!("Approve (nothing to review)"), "{s}");
}
