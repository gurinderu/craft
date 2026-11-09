//! What counts as a job running an entry's command (realm @nick/craft, node #482): the whole
//! command, not a substring of one — `cargo` its first word past `VAR=x` assignments, further
//! arguments only where they keep the signal exercised, no `||` swallowing its failure, and no
//! text after an inline run's comment.

use super::CiEntry;

pub(super) const WF: &str = ".github/workflows/ci.yml";

pub(super) fn top(workflow: &str, justfile: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(".github/workflows")).unwrap();
    std::fs::write(dir.path().join(WF), workflow).unwrap();
    std::fs::write(dir.path().join("justfile"), justfile).unwrap();
    dir
}

pub(super) fn entry(check: &str, signal: &str, command: &str, sources: &str) -> String {
    format!(
        r#"{{"check":"{check}","signal":"{signal}","command":"{command}","workflow":"{WF}","sources":{sources}}}"#
    )
}

/// Whether a job `lint` whose step runs `run` grounds `command` for `signal`.
fn runs(run: &str, signal: &str, command: &str) -> bool {
    let wf = format!("jobs:\n  lint:\n    steps:\n      - run: {run}\n");
    let t = top(&wf, "");
    CiEntry::confirmed(&entry("lint", signal, command, "[]"), t.path()).is_ok()
}

pub(super) const CLIPPY: &str = "cargo clippy -- -D warnings";

#[test]
fn a_job_command_grounds_only_the_whole_command_or_it_with_further_arguments() {
    assert!(runs(CLIPPY, "clippy", CLIPPY));
    assert!(runs("cargo   clippy --  -D warnings", "clippy", CLIPPY));
    assert!(runs(
        "cd cli && cargo clippy -- -D warnings",
        "clippy",
        CLIPPY
    ));
    assert!(runs(
        "RUSTFLAGS=x cargo clippy",
        "clippy",
        "RUSTFLAGS=x cargo clippy"
    ));
    assert!(runs(
        "cargo test --locked --workspace",
        "test",
        "cargo test --locked"
    ));
    assert!(
        !runs("cargo clippy -- -D warningsx", "clippy", CLIPPY),
        "a word, not its prefix"
    );
    assert!(
        !runs("xcargo clippy -- -D warnings", "clippy", CLIPPY),
        "a longer word"
    );
    assert!(
        !runs("cargo clippy -- -D", "clippy", CLIPPY),
        "a shorter command"
    );
    assert!(!runs("echo cargo clippy -- -D warnings", "clippy", CLIPPY));
    assert!(!runs(
        "echo \"cargo clippy -- -D warnings\"",
        "clippy",
        CLIPPY
    ));
    assert!(!runs(
        "printf 'cargo clippy -- -D warnings'",
        "clippy",
        CLIPPY
    ));
}

#[test]
fn a_command_cut_out_of_a_quoted_string_does_not_ground() {
    let quoted = format!("echo \"x; {CLIPPY} more\"");
    assert!(!runs(&quoted, "clippy", CLIPPY));
    let single = format!("echo 'x && {CLIPPY}'");
    assert!(!runs(&single, "clippy", CLIPPY));
    let skip = format!("{CLIPPY} -A \"clippy::x\"");
    assert!(
        runs(&skip, "clippy", CLIPPY),
        "balanced quotes are arguments"
    );
}

#[test]
fn arguments_that_stop_the_signal_from_running_do_not_ground() {
    assert!(!runs("cargo test --no-run", "test", "cargo test"));
    assert!(!runs(
        "cargo test --locked --no-run",
        "test",
        "cargo test --locked"
    ));
    assert!(!runs("cargo clippy --help", "clippy", "cargo clippy"));
    assert!(!runs("cargo clippy --version", "clippy", "cargo clippy"));
    assert!(!runs("cargo test &", "test", "cargo test"), "backgrounded");
}

#[test]
fn a_command_whose_failure_is_swallowed_does_not_ground() {
    for tail in ["|| true", "||true", "|| :", "|| exit 0", "|| echo failed"] {
        assert!(
            !runs(&format!("{CLIPPY} {tail}"), "clippy", CLIPPY),
            "{tail}"
        );
    }
    assert!(runs(&format!("{CLIPPY} || exit 1"), "clippy", CLIPPY));
    assert!(
        !runs(&format!("true || {CLIPPY}"), "clippy", CLIPPY),
        "runs only if true fails"
    );
    assert!(runs(&format!("true && {CLIPPY}; true"), "clippy", CLIPPY));
}

#[test]
fn a_comment_after_an_inline_run_spells_nothing() {
    assert!(!runs(&format!("true # {CLIPPY}"), "clippy", CLIPPY));
    assert!(runs(&format!("\"{CLIPPY}\" # the lint"), "clippy", CLIPPY));
    assert!(runs(
        &format!("'{CLIPPY} #1'"),
        "clippy",
        &format!("{CLIPPY} #1")
    ));
}
