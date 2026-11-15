//! The checks of a reusable workflow (realm @nick/craft, node #482): GitHub reports a called job as
//! `<caller> / <job>` and the calling job under no check of its own, so the map proposes, writes
//! and claims the called job by that name; a same-named job that runs something else still
//! collides, and an edit of the calling workflow marks the entry stale.

use super::CiEntry;
use super::candidates::{Candidate, candidates};
use super::workflow_on::called_only;

const CI: &str = ".github/workflows/ci.yml";
const LINTS: &str = ".github/workflows/lints.yml";
const DOCS: &str = ".github/workflows/docs.yml";

/// The shape of a repository whose `ci` calls a per-concern workflow, each `on: workflow_call` only.
const CALLER: &str = "name: ci\non:\n  pull_request:\njobs:\n  changes:\n    name: changes\n    steps:\n      - run: echo rust=true\n  lints:\n    needs: changes\n    if: needs.changes.outputs.rust == 'true'\n    uses: ./.github/workflows/lints.yml\n    secrets:\n      TOKEN: ${{ secrets.TOKEN }}\n";
const CALLED: &str = "name: \"lints\"\non:\n  workflow_call:\n    secrets:\n      TOKEN:\n        required: false\njobs:\n  lints: \n    name: \"lints\"\n    steps:\n      - name: Run cargo check\n        run: cargo check -v --all-features\n      - name: Run cargo clippy\n        run: cargo clippy --all-targets --all-features\n";

fn top(files: &[(&str, &str)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(".github/workflows")).unwrap();
    for (path, text) in files {
        std::fs::write(dir.path().join(path), text).unwrap();
    }
    dir
}

fn entry(check: &str) -> String {
    format!(
        r#"{{"check":"{check}","signal":"clippy","command":"cargo clippy --all-targets --all-features","workflow":"{LINTS}"}}"#
    )
}

fn checks(t: &tempfile::TempDir) -> Vec<(String, bool)> {
    candidates(t.path())
        .unwrap()
        .into_iter()
        .map(|c| match c {
            Candidate::Resolved(r) => (r.check, true),
            Candidate::Unresolved(u) => (u.check, false),
        })
        .collect()
}

#[test]
fn a_called_job_is_proposed_as_github_reports_it_through_its_caller() {
    let t = top(&[(CI, CALLER), (LINTS, CALLED)]);
    let got = checks(&t);
    assert_eq!(
        got,
        [
            ("lints / lints".to_owned(), true),
            ("lints / lints".to_owned(), true)
        ],
        "the calling job has no check of its own"
    );
}

#[test]
fn a_called_job_is_written_under_its_reported_check_the_calling_workflow_hashed() {
    let t = top(&[(CI, CALLER), (LINTS, CALLED)]);
    let e = CiEntry::confirmed(&entry("lints / lints"), t.path()).unwrap();
    assert!(
        e.hashes.contains_key(CI) && e.hashes.contains_key(LINTS),
        "{e:?}"
    );
    assert!(e.unmatched(t.path()).is_none() && e.fresh(t.path()));
    std::fs::write(t.path().join(CI), CALLER.replace("rust=true", "rust=false")).unwrap();
    assert_eq!(
        e.changed(t.path()),
        [CI],
        "the caller decides whether it runs"
    );
}

#[test]
fn the_bare_name_of_a_job_github_reports_only_through_its_caller_is_refused_naming_that_check() {
    let t = top(&[(CI, CALLER), (LINTS, CALLED)]);
    let err = CiEntry::confirmed(&entry("lints"), t.path())
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("`lints / lints`") && !err.contains("rename one of the jobs"),
        "{err}"
    );
}

#[test]
fn a_job_running_something_else_under_the_called_check_still_collides() {
    let docs =
        "on: push\njobs:\n  docs:\n    name: lints / lints\n    steps:\n      - run: mdbook test\n";
    let t = top(&[(CI, CALLER), (LINTS, CALLED), (DOCS, docs)]);
    let err = CiEntry::confirmed(&entry("lints / lints"), t.path())
        .unwrap_err()
        .to_string();
    assert!(err.contains(DOCS) && err.contains("run:"), "{err}");
}

#[test]
fn a_workflow_also_run_on_its_own_reports_its_jobs_by_their_names_too() {
    let both = CALLED.replace("on:\n  workflow_call:", "on:\n  push:\n  workflow_call:");
    let t = top(&[(CI, CALLER), (LINTS, &both)]);
    let mut got = checks(&t);
    got.dedup();
    assert_eq!(
        got,
        [
            ("lints".to_owned(), true),
            ("lints / lints".to_owned(), true)
        ]
    );
    CiEntry::confirmed(&entry("lints"), t.path()).unwrap();
}

#[test]
fn a_matrix_caller_s_runs_have_no_check_and_a_workflow_nobody_calls_none_at_all() {
    let matrix = CALLER.replace(
        "    uses: ./",
        "    strategy:\n      matrix:\n        os: [a, b]\n    uses: ./",
    );
    let t = top(&[(CI, &matrix), (LINTS, CALLED)]);
    let got = checks(&t);
    assert!(
        got.iter()
            .all(|(c, resolved)| !resolved && c.contains("${{")),
        "{got:?}"
    );
    let alone = top(&[(LINTS, CALLED)]);
    assert!(checks(&alone).is_empty());
}

#[test]
fn a_workflow_is_called_only_when_workflow_call_is_its_one_trigger() {
    for only in [
        "on: workflow_call\njobs:\n",
        "on: [workflow_call]\n",
        "\"on\":\n  workflow_call:\n    inputs:\n      x:\n        type: string\n",
        "on:\n  # called\n  workflow_call:\n",
    ] {
        assert!(called_only(only), "{only}");
    }
    for not in [
        "on: [push, workflow_call]\n",
        "on:\n  workflow_call:\n  push:\n    branches: [main]\n",
        "on: push\n",
        "jobs:\n  a:\n    steps:\n      - run: cargo test\n",
    ] {
        assert!(!called_only(not), "{not}");
    }
}
