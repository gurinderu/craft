//! `craft runs enrich-cost | sorting-choice | develop-cycle` end to end, as a launcher or a skill
//! runs them: a run's cost folded into its record (twice changes nothing), a reviewer's choice
//! written into the run's record, and a develop cycle filed with its index line.
#![expect(
    clippy::unwrap_used,
    reason = "the fixture fails the test loudly, like the tests it serves"
)]

use std::io::Write;
use std::path::Path;
use std::process::{Command, Output, Stdio};

use serde_json::{Value, json};

fn craft(store: &Path, args: &[&str], stdin: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_craft"))
        .arg("runs")
        .arg("--store")
        .arg(store)
        .args(args)
        .env_remove("CLAUDE_CONFIG_DIR")
        .env("CRAFT_CODE_GRAPH", "")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(ok.status.success(), "{}", text(&ok.stderr));
}

#[test]
fn a_finished_runs_cost_lands_in_its_record_once_however_often_it_is_enriched() {
    let (home, store) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let store_dir = std::fs::canonicalize(store.path()).unwrap();
    let record = store_dir.join("2026-11-01T10-00-00Z-workflow-review.json");
    std::fs::write(
        &record,
        r#"{"schemaVersion":1,"name":"review","verdict":"Approve"}"#,
    )
    .unwrap();
    let run = home
        .path()
        .join("projects/-repo/s1/subagents/workflows/wf_e2e");
    std::fs::create_dir_all(&run).unwrap();
    let usage = |id: &str, out: u64| {
        json!({"type": "assistant", "timestamp": "2026-11-01T09:00:00Z", "message": {"id": id,
            "usage": {"input_tokens": 1, "output_tokens": out, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 2}}})
    };
    let filed = json!({"type": "user", "timestamp": "2026-11-01T09:01:00Z", "message": {"content": [
        {"type": "tool_result", "content": format!("wrote {}", record.display())}]}});
    std::fs::write(
        run.join("agent-a.jsonl"),
        format!("{}\n{}\n", usage("m1", 5), usage("m1", 5)),
    )
    .unwrap();
    std::fs::write(
        run.join("agent-b.jsonl"),
        format!("{}\n{filed}\n", usage("m2", 3)),
    )
    .unwrap();
    std::fs::write(
        run.join("agent-b.meta.json"),
        r#"{"description":"log-run"}"#,
    )
    .unwrap();
    let args = [
        "enrich-cost",
        "--run-id",
        "wf_e2e",
        "--claude-home",
        home.path().to_str().unwrap(),
    ];
    let out = craft(&store_dir, &args, "");
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert!(
        text(&out.stdout).contains("1 record(s)"),
        "{}",
        text(&out.stdout)
    );
    let once = std::fs::read_to_string(&record).unwrap();
    let r: Value = serde_json::from_str(&once).unwrap();
    assert_eq!(r["verdict"], "Approve");
    assert_eq!(
        r["cost"],
        json!({"output": 8, "input": 2, "cacheRead": 200, "cacheWrite": 4, "total": 214, "agents": 2,
            "source": "wf_e2e", "rule": "per-message", "slice": {"index": 1, "of": 1}})
    );
    let again = craft(&store_dir, &args, "");
    assert!(again.status.success(), "{}", text(&again.stderr));
    assert_eq!(std::fs::read_to_string(&record).unwrap(), once);
    let missing = craft(
        &store_dir,
        &[
            "enrich-cost",
            "--run-id",
            "wf_none",
            "--claude-home",
            home.path().to_str().unwrap(),
        ],
        "",
    );
    assert_eq!(missing.status.code(), Some(1));
    assert!(
        text(&missing.stderr).contains("no transcript directory for run wf_none"),
        "{}",
        text(&missing.stderr)
    );
}

#[test]
fn a_reviewers_choice_lands_in_the_newest_sorted_record_of_the_branch() {
    let (repo, store) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let repo_dir = std::fs::canonicalize(repo.path()).unwrap();
    git(&repo_dir, &["init", "-q", "-b", "feat/x"]);
    git(&repo_dir, &["commit", "-q", "--allow-empty", "-m", "a"]);
    let record = store
        .path()
        .join("2026-11-01T10-00-00Z-workflow-review.json");
    let sorted = json!({"project": repo_dir, "branch": "feat/x", "sorting": {"defects": 0,
        "findings": [{"n": 1, "title": "t", "file": "a.rs", "line": 3}]}});
    std::fs::write(&record, serde_json::to_string_pretty(&sorted).unwrap()).unwrap();
    let project = repo_dir.to_str().unwrap();
    let out = craft(
        store.path(),
        &[
            "sorting-choice",
            "--n",
            "1",
            "--choice",
            "question",
            "--project",
            project,
        ],
        "",
    );
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert!(
        text(&out.stdout).starts_with("recorded question for doubtful finding 1 (t @ a.rs:3) in ")
    );
    let r: Value = serde_json::from_str(&std::fs::read_to_string(&record).unwrap()).unwrap();
    assert_eq!(r["sorting"]["choices"]["1"]["choice"], "question");
    let none = craft(
        store.path(),
        &[
            "sorting-choice",
            "--n",
            "9",
            "--choice",
            "defect",
            "--project",
            project,
        ],
        "",
    );
    assert_eq!(none.status.code(), Some(1));
    assert!(
        text(&none.stderr).contains("the record lists no doubtful finding numbered 9"),
        "{}",
        text(&none.stderr)
    );
    // `--n` is read as JavaScript's `Number()` reads it: U+FEFF trimmed, a radix literal read in
    // its base, U+0085 no whitespace.
    for n in ["\u{feff}1\u{feff}", "0x1"] {
        let again = craft(
            store.path(),
            &[
                "sorting-choice",
                "--n",
                n,
                "--choice",
                "defect",
                "--project",
                project,
            ],
            "",
        );
        assert!(again.status.success(), "{n:?}: {}", text(&again.stderr));
    }
    let next_line = craft(
        store.path(),
        &[
            "sorting-choice",
            "--n",
            "\u{85}1",
            "--choice",
            "defect",
            "--project",
            project,
        ],
        "",
    );
    assert_eq!(next_line.status.code(), Some(1));
}

#[test]
fn a_develop_cycle_is_filed_with_its_index_line_and_a_bad_one_refused_by_name() {
    let (repo, store) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let repo_dir = std::fs::canonicalize(repo.path()).unwrap();
    git(&repo_dir, &["init", "-q", "-b", "feat/d"]);
    git(&repo_dir, &["commit", "-q", "--allow-empty", "-m", "a"]);
    let cycle = r#"{"outcome":"capped","rounds":[{"engine":"review","scope":"full","verdict":"Block","mediumPlus":1}]}"#;
    let project = repo_dir.to_str().unwrap();
    let out = craft(
        store.path(),
        &["develop-cycle", "--project", project, "--session", "s-9"],
        cycle,
    );
    assert!(out.status.success(), "{}", text(&out.stderr));
    let file = text(&out.stdout)
        .trim()
        .strip_prefix("wrote ")
        .unwrap()
        .to_owned();
    let r: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(
        (
            r["kind"].as_str(),
            r["verdict"].as_str(),
            r["round"].as_u64()
        ),
        (Some("develop"), Some("capped"), Some(1))
    );
    assert_eq!(
        (r["branch"].as_str(), r["session"].as_str()),
        (Some("feat/d"), Some("s-9"))
    );
    let index = std::fs::read_to_string(store.path().join("index.jsonl")).unwrap();
    assert_eq!(index.lines().count(), 1);
    assert!(index.contains("\"kind\":\"develop\""), "{index}");
    let bad = craft(
        store.path(),
        &["develop-cycle", "--project", project],
        r#"{"outcome":"done"}"#,
    );
    assert_eq!(bad.status.code(), Some(1));
    assert!(
        text(&bad.stderr)
            .contains("outcome must be one of converged, capped, no-verdict, got \"done\""),
        "{}",
        text(&bad.stderr)
    );
    let empty = craft(store.path(), &["develop-cycle", "--project", project], " ");
    assert!(
        text(&empty.stderr).contains("no record on stdin"),
        "{}",
        text(&empty.stderr)
    );
}
