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

#[path = "triage_refused/stdin.rs"]
mod stdin;

fn start_command(args: &[&str], cwd: &Path, run: &Path, home: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_craft"));
    command
        .args(["triage", "start", "--run-dir"])
        .arg(run)
        .args(args)
        .current_dir(cwd)
        .env("HOME", home);
    command
}

fn triage_start(args: &[&str], cwd: &Path, run: &Path, home: &Path) -> Output {
    start_command(args, cwd, run, home)
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

fn submit(run: &Path, home: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(["triage", "submit", "--run"])
        .arg(run)
        .env("HOME", home)
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

fn failure(out: &Output, why: &str) {
    let said = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(1), "{said}");
    assert!(said.contains(why), "{said}");
    assert!(
        out.stdout.is_empty(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
}

#[test]
fn existing_runs_and_paths_that_cannot_be_created_exit_1_not_argument_refusal() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path();
    let run = home.join("run");
    let first = triage_start(&["--report", "/r.md"], home, &run, home);
    assert!(first.status.success(), "{first:?}");
    failure(
        &triage_start(&["--report", "/r.md"], home, &run, home),
        "holds a triage already",
    );
    let file = home.join("file");
    std::fs::write(&file, "not a directory").unwrap();
    failure(
        &triage_start(&["--report", "/r.md"], home, &file.join("run"), home),
        "creating",
    );
}

#[test]
fn an_unwritable_plan_and_a_finished_run_exit_1_not_argument_refusal() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path();
    let run = home.join("run");
    let first = triage_start(&["--report", "/r.md"], home, &run, home);
    answer(&first, r#"{"source":"review","findings":[]}"#);
    let pending = submit(&run, home);
    answer(
        &pending,
        r#"{"plan_markdown":"BODY","summary":"SUM","ledger":[]}"#,
    );
    let plan = run.join("plan.json");
    std::fs::create_dir(&plan).unwrap();
    failure(&submit(&run, home), "writing");
    std::fs::remove_dir(&plan).unwrap();
    let finished = submit(&run, home);
    assert!(finished.status.success(), "{finished:?}");
    let step: serde_json::Value = serde_json::from_slice(&finished.stdout).unwrap();
    assert_eq!(step["done"], true);
    failure(&submit(&run, home), "is done");
}

fn answer(out: &Output, text: &str) {
    assert!(out.status.success(), "{out:?}");
    let step: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    std::fs::write(
        step.pointer("/tasks/0/answerFile")
            .unwrap()
            .as_str()
            .unwrap(),
        text,
    )
    .unwrap();
}
