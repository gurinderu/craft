//! A changed Markdown runbook whose change touches a step — a shell block's or a numbered step's
//! command against an external system — goes to the runbook profile and its lens, under `.github/`
//! and with an upper-case name too; prose, a change beside the steps and a file that cannot be read
//! safely do not, the last said in the report.

mod common;

use std::path::Path;

use common::{git, ids, opts, prompt_of, scout, submit};
use craft_review::step;
use serde_json::{Value, json};

const STEPS: &str = "# Recover OVN\n\nFind the leader.\n\n```sh\nkubectl -n kube-system get pods -l app=ovn-central\nkubectl -n kube-system delete pod ovn-central-0\n```\n";

/// A repository whose `origin/main` holds `before`, with `after` written on top and committed.
#[expect(
    clippy::unwrap_used,
    reason = "a step of the tests, failing loudly like them"
)]
fn repo(before: &[(&str, &str)], after: &[(&str, &str)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    git(d, &["init", "-q", "-b", "main"]);
    let write = |files: &[(&str, &str)]| {
        for (f, text) in files {
            let path = d.join(f);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
    };
    write(&[("LICENSE", "x\n")]);
    write(before);
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "init"]);
    git(d, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    write(after);
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "docs: the OVN recovery runbook"]);
    dir
}

#[expect(
    clippy::unwrap_used,
    reason = "a step of the tests, failing loudly like them"
)]
fn start(cwd: &Path, out: &Path) -> Value {
    step::start(&opts(cwd, out)).unwrap()
}

fn report(s: &Value) -> String {
    std::fs::read_to_string(s["report"].as_str().unwrap_or_default()).unwrap_or_default()
}

#[test]
fn a_runbook_goes_to_the_runbook_lens_and_prose_beside_it_does_not() {
    let repo = repo(
        &[],
        &[
            ("docs/ovn-recovery.md", STEPS),
            ("README.md", "# Project\n\nWe run kubectl in production.\n"),
        ],
    );
    let out = tempfile::tempdir().unwrap();
    // Started from a subdirectory: the files are still read from the repository's top.
    let s = start(&repo.path().join("docs"), out.path());
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
        json!({"scout-runbook": scout("small", &[])}),
    );
    assert_eq!(
        ids(&s),
        ["lens-runbook-runbook-r1"],
        "the lens runs with no pick: {s}"
    );
    let p = prompt_of(&s["tasks"][0]);
    assert!(
        p.contains("You are the **runbook** review lens for a Markdown runbook diff"),
        "{p}"
    );
    assert!(
        p.contains("READ-ONLY: you judge the procedure, you never run it"),
        "{p}"
    );
    assert!(p.contains("SECRETS AND ACCESS"), "{p}");
}

#[test]
fn a_runbook_under_github_or_with_an_upper_case_name_is_a_runbook_too() {
    let repo = repo(
        &[],
        &[(".github/RELEASE.md", STEPS), ("OPS/RUNBOOK.MD", STEPS)],
    );
    let out = tempfile::tempdir().unwrap();
    let s = start(repo.path(), out.path());
    let p = prompt_of(&s["tasks"][0]);
    assert!(p.contains("':(literal).github/RELEASE.md'"), "{p}");
    assert!(p.contains("':(literal)OPS/RUNBOOK.MD'"), "{p}");
}

#[test]
fn a_change_that_touches_no_step_buys_no_lens() {
    let typo = STEPS.replace("Find the leader.", "Find the leader first.");
    let prose = repo(&[("docs/ovn.md", STEPS)], &[("docs/ovn.md", &typo)]);
    let out = tempfile::tempdir().unwrap();
    let s = start(prose.path(), out.path());
    assert_eq!(s["verdict"], json!("Approve (nothing to review)"), "{s}");
    let fixed = STEPS.replace("delete pod ovn-central-0", "delete pod ovn-central-1");
    let step = repo(&[("docs/ovn.md", STEPS)], &[("docs/ovn.md", &fixed)]);
    let out = tempfile::tempdir().unwrap();
    assert_eq!(ids(&start(step.path(), out.path())), ["scout-runbook"]);
}

#[test]
fn a_markdown_file_that_cannot_be_read_safely_is_named_not_dropped() {
    let linked = repo(&[], &[("CHANGELOG.md", "x\n")]);
    let d = linked.path();
    std::os::unix::fs::symlink("/etc/hostname", d.join("ops.md")).unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "docs: link"]);
    let out = tempfile::tempdir().unwrap();
    let s = start(d, out.path());
    let r = report(&s);
    assert!(
        r.contains("ops.md could not be read (reached through a link)"),
        "{r}"
    );
    assert!(r.contains("NOT reviewed by the runbook lens"), "{r}");
}
