use super::candidates::{Candidate, candidates_in};
use super::ci::Signal;
use super::workflow::{Job, jobs};

const CI: &str = r#"name: CI
on:
  push:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
  rust:
    name: Rust
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: cli
    steps:
      - name: fmt
        run: cargo fmt --check
      - name: clippy
        run: "cargo clippy --all-targets --locked -- -D warnings"
      - name: tests and build
        run: |
          cd cli && cargo test --locked
          RUSTFLAGS=-Dwarnings cargo +nightly build --release
  lint: # the recipe
    strategy:
      matrix:
        os: [ubuntu, macos]
    steps:
      - run: just lint
      - run: >-
          ./scripts/check.sh
          --all
  docs:
    steps:
      - uses: "./.github/actions/docs/" # local
      - run: make docs
"#;

#[test]
fn jobs_are_read_with_their_name_matrix_and_run_lines() {
    let got = jobs(CI);
    let ids: Vec<&str> = got.iter().map(|j| j.id.as_str()).collect();
    assert_eq!(ids, ["test", "rust", "lint", "docs"]);
    assert_eq!(
        got[1],
        Job {
            id: "rust".into(),
            name: Some("Rust".into()),
            matrix: false,
            runs: vec![
                "cargo fmt --check".into(),
                "cargo clippy --all-targets --locked -- -D warnings".into(),
                "cd cli && cargo test --locked".into(),
                "RUSTFLAGS=-Dwarnings cargo +nightly build --release".into(),
            ],
            uses: Vec::new(),
        },
        "the `defaults: run:` mapping is no run line"
    );
    assert!(got[2].matrix);
    assert_eq!(
        got[2].runs,
        ["just lint", "./scripts/check.sh --all"],
        "a folded block is one line"
    );
    assert!(got[0].uses.is_empty(), "a remote action is not local");
    assert_eq!(got[3].uses, [".github/actions/docs"]);
}

#[test]
fn a_job_naming_cargo_is_resolved_and_one_calling_a_recipe_is_not() {
    let got = candidates_in(".github/workflows/ci.yml", CI);
    let resolved: Vec<(&str, Signal, &str)> = got
        .iter()
        .filter_map(|c| match c {
            Candidate::Resolved(r) => Some((r.check.as_str(), r.signal, r.command.as_str())),
            Candidate::Unresolved(_) => None,
        })
        .collect();
    assert_eq!(
        resolved,
        [
            ("Rust", Signal::Fmt, "cargo fmt --check"),
            (
                "Rust",
                Signal::Clippy,
                "cargo clippy --all-targets --locked -- -D warnings"
            ),
            ("Rust", Signal::Test, "cargo test --locked"),
            (
                "Rust",
                Signal::Build,
                "RUSTFLAGS=-Dwarnings cargo +nightly build --release"
            ),
        ]
    );
    let open: Vec<_> = got
        .iter()
        .filter_map(|c| match c {
            Candidate::Unresolved(u) => Some(u),
            Candidate::Resolved(_) => None,
        })
        .collect();
    assert_eq!(
        open.len(),
        1,
        "npm ci is no recipe; make docs hints no signal"
    );
    let lint = open[0];
    assert_eq!((lint.check.as_str(), lint.matrix), ("lint", true));
    assert_eq!(lint.runs, ["just lint", "./scripts/check.sh --all"]);
    assert_eq!(lint.hints, [Signal::Clippy]);
    assert_eq!(lint.workflow, ".github/workflows/ci.yml");
}

#[test]
fn nextest_tests_and_check_builds_while_xtask_is_a_recipe() {
    let yml = "jobs:\n  t:\n    steps:\n      - run: cargo nextest run\n      - run: cargo check\n      - run: cargo xtask test\n";
    let got = candidates_in("w.yml", yml);
    let signals: Vec<Signal> = got
        .iter()
        .filter_map(|c| match c {
            Candidate::Resolved(r) => Some(r.signal),
            Candidate::Unresolved(_) => None,
        })
        .collect();
    assert_eq!(signals, [Signal::Test, Signal::Build]);
    assert!(matches!(&got[2], Candidate::Unresolved(u) if u.runs == ["cargo xtask test"]));
}
