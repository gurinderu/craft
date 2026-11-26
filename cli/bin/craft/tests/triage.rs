//! `craft triage start` as a host runs it: the run opened with its first tasks, and `--record`
//! kept in the run's arguments — the craft version its record is filed under and the session it
//! names (realm @nick/craft, node #616) — and the bounded store writer the binary files a triage's
//! record through, landing it in the run store under HOME.
#![expect(
    clippy::unwrap_used,
    reason = "fixture setup and JSON assertions fail loudly"
)]

use std::path::Path;
use std::process::Command;

use serde_json::Value;

fn start(home: &Path, repo: &Path, run: &Path, extra: &[&str]) -> Value {
    let report = repo.join("report.md");
    std::fs::write(&report, "- [High] src/a.rs:1 — a finding\n").unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(["triage", "start", "--cwd"])
        .arg(repo)
        .arg("--run-dir")
        .arg(run)
        .arg("--report")
        .arg(&report)
        .args(extra)
        .env("HOME", home)
        .env("CLAUDE_CODE_SESSION_ID", "s-7")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}

fn args_of(run: &Path) -> Value {
    let state: Value =
        serde_json::from_str(&std::fs::read_to_string(run.join("state.json")).unwrap()).unwrap();
    state.get("args").cloned().unwrap()
}

#[test]
fn a_triage_started_recording_keeps_its_version_and_session_and_hands_out_its_gatherer() {
    let d = tempfile::tempdir().unwrap();
    let (home, repo, run) = (
        d.path().join("home"),
        d.path().join("repo"),
        d.path().join("run"),
    );
    std::fs::create_dir_all(&repo).unwrap();
    let step = start(&home, &repo, &run, &["--record", "9.9.9"]);
    let tasks = step["tasks"].as_array().unwrap();
    assert!(!tasks.is_empty(), "{step}");
    let args = args_of(&run);
    assert_eq!(args["craftVersion"], "9.9.9");
    assert_eq!(args["record"]["session"], "s-7");
}

#[test]
fn a_triage_started_without_record_files_nothing_under_this_binarys_version() {
    let d = tempfile::tempdir().unwrap();
    let (home, repo, run) = (
        d.path().join("home"),
        d.path().join("repo"),
        d.path().join("run"),
    );
    std::fs::create_dir_all(&repo).unwrap();
    start(&home, &repo, &run, &[]);
    let args = args_of(&run);
    assert_eq!(args["craftVersion"], env!("CARGO_PKG_VERSION"));
    assert!(args.get("record").is_none(), "{args}");
}

#[test]
fn the_binarys_bounded_writer_lands_a_built_record_in_the_run_store_under_home() {
    use std::io::Write;
    let d = tempfile::tempdir().unwrap();
    let (home, repo) = (d.path().join("home"), d.path().join("repo"));
    std::fs::create_dir_all(&repo).unwrap();
    let call = serde_json::json!({
        "run": d.path(),
        "root": "",
        "command": "record",
        "request": {"repo": repo, "session": "", "retry": false,
            "record": {"kind": "workflow", "name": "triage-findings", "verdict": ""}},
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_craft"))
        .arg("__craft-file-run")
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(call.to_string().as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    let said: Value = serde_json::from_slice(&out.stdout).unwrap();
    let answer = said.get("Ok").unwrap();
    assert_eq!(answer.get("ok"), Some(&Value::Bool(true)), "{said}");
    let store = home.join(".craft/runs");
    let file = answer.get("file").and_then(Value::as_str).unwrap();
    assert!(Path::new(file).starts_with(&store), "{file}");
    let index = std::fs::read_to_string(store.join("index.jsonl")).unwrap();
    assert_eq!(index.lines().count(), 1, "{index}");
    assert!(index.contains("\"name\":\"triage-findings\""), "{index}");
}

fn submit(home: &Path, run: &Path, extra: &[&str]) -> Value {
    let out = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(["triage", "submit", "--run"])
        .arg(run)
        .args(extra)
        .env("HOME", home)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}

#[test]
fn submit_takes_the_hosts_limit_a_resume_and_an_abandoned_task() {
    let d = tempfile::tempdir().unwrap();
    let (home, repo, run) = (
        d.path().join("home"),
        d.path().join("repo"),
        d.path().join("run"),
    );
    std::fs::create_dir_all(&repo).unwrap();
    let first = start(&home, &repo, &run, &[]);
    let id = first["tasks"][0]["id"].as_str().unwrap().to_owned();
    let task = |run: &Path| {
        let state: Value =
            serde_json::from_str(&std::fs::read_to_string(run.join("state.json")).unwrap())
                .unwrap();
        state["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == id.as_str())
            .cloned()
            .unwrap()
    };
    // No answer written: a resume hands it out again uncounted, a plain submit counts a retry.
    submit(&home, &run, &["--resume"]);
    assert_eq!(task(&run)["retries"], 0, "{}", task(&run));
    submit(&home, &run, &[]);
    assert_eq!(task(&run)["retries"], 1, "{}", task(&run));
    let stopped = submit(&home, &run, &["--limit", "the limit"]);
    assert_eq!(stopped["stopped"]["text"], "the limit", "{stopped}");
    let gone = submit(&home, &run, &["--abandoned", &id]);
    assert!(gone.get("stopped").is_none(), "{gone}");
    let t = task(&run);
    assert_eq!(
        (&t["state"], &t["abandoned"]),
        (&Value::from("failed"), &Value::Bool(true)),
        "{t}"
    );
}
