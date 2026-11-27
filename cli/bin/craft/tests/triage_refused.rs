//! `craft triage start` refuses an argument as an argument is refused: exit 2, the reason on
//! stderr, nothing on stdout, no run made — a triage with no source, a repository that is not
//! there, a prior ledger that is no list, both lists from stdin (realm @nick/craft, nodes #523, #616). The engine's driver
//! tells such a refusal from a failure by that exit.
#![expect(
    clippy::unwrap_used,
    reason = "the fixture helpers fail the test loudly, like the tests they serve"
)]

use std::path::Path;
use std::process::{Command, Output, Stdio};

fn triage_start(args: &[&str], cwd: &Path, run: &Path, home: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(["triage", "start", "--run-dir"])
        .arg(run)
        .args(args)
        .current_dir(cwd)
        .env("HOME", home)
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

#[test]
fn each_refused_argument_exits_2_with_its_reason_and_makes_no_run() {
    let (cwd, home, tmp) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let ledger = tmp.path().join("ledger.json");
    std::fs::write(&ledger, r#"{"stable_id": "a"}"#).unwrap();
    let missing = tmp.path().join("no-such-repo");
    let cases: [(Vec<&str>, &str); 4] = [
        (vec!["--base", "x"], "needs a source"),
        (
            vec!["--report", "/r.md", "--repo", missing.to_str().unwrap()],
            "reading the repository",
        ),
        (
            vec![
                "--report",
                "/r.md",
                "--prior-ledger",
                ledger.to_str().unwrap(),
            ],
            "the prior ledger is not a JSON list",
        ),
        (
            vec![
                "--report",
                "/r.md",
                "--prior-ledger",
                "-",
                "--prior-decisions",
                "-",
            ],
            "cannot both be read from stdin",
        ),
    ];
    for (i, (args, why)) in cases.iter().enumerate() {
        let run = tmp.path().join(format!("run-{i}"));
        let out = triage_start(args, cwd.path(), &run, home.path());
        let said = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(2), "{args:?}: {said}");
        assert!(said.contains(why), "{args:?}: {said}");
        assert!(out.stdout.is_empty(), "{args:?}");
        assert!(!run.join("state.json").exists(), "{args:?}: no run is made");
    }
}

#[test]
fn one_list_read_from_stdin_is_no_refusal_of_both() {
    let (cwd, home, tmp) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let out = triage_start(
        &["--report", "/r.md", "--prior-ledger", "-"],
        cwd.path(),
        &tmp.path().join("run"),
        home.path(),
    );
    let said = String::from_utf8_lossy(&out.stderr);
    assert!(!said.contains("cannot both be read from stdin"), "{said}");
}
