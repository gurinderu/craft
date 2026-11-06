//! The step protocol end to end over a fixture repository with a real git diff.
#![expect(
    clippy::unwrap_used,
    reason = "the fixture helpers fail the test loudly, like the tests they serve"
)]

use std::path::Path;
use std::process::Command;

use craft_review::status;
use craft_review::step::{self, StartOptions};
use serde_json::{Map, Value, json};

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .unwrap();
    assert!(
        ok.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&ok.stderr)
    );
}

/// A repository whose `origin/main` is its first commit, with `src/lib.rs` added after it.
fn fixture(rust: bool) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    git(d, &["init", "-q", "-b", "main"]);
    std::fs::write(d.join("README.md"), "x\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "init"]);
    git(d, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    let (name, text) = if rust {
        ("lib.rs", "pub fn f() -> u8 { 1 }\n")
    } else {
        ("notes.txt", "y\n")
    };
    std::fs::create_dir_all(d.join("src")).unwrap();
    std::fs::write(d.join("src").join(name), text).unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "feat: add f, which never fails"]);
    dir
}

fn opts(repo: &Path, run: &Path) -> StartOptions {
    StartOptions {
        cwd: repo.to_path_buf(),
        base: None,
        run_dir: run.join("run"),
        craft_root: Some("/craft".into()),
        craft_version: Some("9.9.9".into()),
    }
}

fn answers(pairs: Value) -> Map<String, Value> {
    pairs.as_object().unwrap().clone()
}

fn finding(severity: &str, line: u32) -> Value {
    json!({
        "severity": severity, "title": format!("bad at {line}"), "file": "src/lib.rs", "line": line,
        "why": "wrong", "fix": "fix it", "blastRadius": "", "source": "intent", "ruleId": "",
        "whereChecked": "", "harmLevel": "intent-unmet", "harm": "callers get 1"
    })
}

fn verdict(refuted: bool) -> Value {
    json!({"refuted": refuted, "citedLineMatches": true, "reachable": true, "premiseSupported": true, "reason": "seen"})
}

fn ids(step: &Value) -> Vec<String> {
    step["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn start_renders_the_lens_over_the_diff() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let s = step::start(&opts(repo.path(), out.path())).unwrap();
    assert_eq!(s["done"], json!(false));
    let task = &s["tasks"][0];
    assert_eq!(task["id"], json!("lens:intent"));
    assert_eq!(task["model"], json!("opus"));
    let prompt = task["prompt"].as_str().unwrap();
    assert!(
        prompt.contains("--merge-base 'origin/main' -- '*.rs'"),
        "{prompt}"
    );
    assert!(
        prompt.contains("feat: add f, which never fails"),
        "the commit log is the spec"
    );
    assert!(prompt.contains("`/craft/skills/review-rules`"));
    assert!(
        !prompt.contains("{{"),
        "an unrendered placeholder: {prompt}"
    );
    assert_eq!(
        task["schema"]["properties"]["findings"]["items"]["type"],
        json!("object")
    );
    assert!(out.path().join("run/state.json").is_file());
    let again = step::start(&opts(repo.path(), out.path())).unwrap_err();
    assert!(again.to_string().contains("holds a run already"), "{again}");
}

#[test]
fn a_full_loop_goes_lens_then_verify_then_done() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = step::start(&opts(repo.path(), out.path())).unwrap()["run"]
        .as_str()
        .unwrap()
        .to_owned();
    let run = Path::new(&run);
    let lens = json!({"lens": "intent", "findings": [finding("High", 1), finding("Medium", 1), finding("Low", 1)]});
    // An agent's final text carrying JSON is read as that JSON.
    let s = step::submit(run, &answers(json!({"lens:intent": lens.to_string()}))).unwrap();
    assert_eq!(ids(&s), ["verify:0", "verify-batch:0"]);
    let batch_prompt = s["tasks"][1]["prompt"].as_str().unwrap();
    assert!(batch_prompt.contains("--- FINDING 1 ---") && batch_prompt.contains("(0..1)"));
    let s = step::submit(
        run,
        &answers(json!({
            "verify:0": verdict(false),
            "verify-batch:0": {"verdicts": [
                {"index": 0, "refuted": false, "citedLineMatches": true, "reachable": false, "premiseSupported": true, "reason": "test-only"},
                {"index": 1, "refuted": true, "citedLineMatches": true, "reachable": true, "premiseSupported": true, "reason": "no"}
            ]}
        })),
    )
    .unwrap();
    assert_eq!(s["done"], json!(true));
    assert_eq!(s["verdict"], json!("Block"));
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert!(
        report.contains("**High** `src/lib.rs:1` — bad at 1"),
        "{report}"
    );
    assert!(
        report.contains("**Low** `src/lib.rs:1`"),
        "an unreachable Medium is demoted: {report}"
    );
    assert!(
        report.contains("3 finding(s) reported: 2 confirmed, 0 suspected, 1 refuted"),
        "{report}"
    );
    let st = status::status(run).unwrap();
    assert_eq!(
        (st["phase"].clone(), st["tiers"]["refuted"].clone()),
        (json!("done"), json!(1))
    );
    let late = step::submit(run, &Map::new()).unwrap_err();
    assert!(late.to_string().contains("is done"), "{late}");
}

#[test]
fn an_invalid_answer_is_asked_again_then_fails_the_task() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&opts(repo.path(), out.path())).unwrap();
    let s = step::submit(&run, &answers(json!({"lens:intent": {"lens": "intent"}}))).unwrap();
    assert_eq!(ids(&s), ["lens:intent"]);
    let prompt = s["tasks"][0]["prompt"].as_str().unwrap();
    assert!(
        prompt.contains("Your previous answer was invalid: it does not match the schema"),
        "{prompt}"
    );
    assert!(
        prompt.contains("findings"),
        "the note names what is missing: {prompt}"
    );
    let s = step::submit(&run, &Map::new()).unwrap();
    assert!(
        s["tasks"][0]["prompt"]
            .as_str()
            .unwrap()
            .contains("no answer was submitted")
    );
    assert_eq!(
        status::status(&run).unwrap()["tasks"][0]["retries"],
        json!(2)
    );
    let s = step::submit(&run, &answers(json!({"lens:intent": "not json"}))).unwrap();
    assert_eq!(
        (s["done"].clone(), s["verdict"].clone()),
        (json!(true), json!("INCOMPLETE"))
    );
}

#[test]
fn a_batch_verdict_missing_an_index_is_asked_again() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&opts(repo.path(), out.path())).unwrap();
    let lens = json!({"lens": "intent", "findings": [finding("Medium", 1), finding("Medium", 2)]});
    step::submit(&run, &answers(json!({"lens:intent": lens}))).unwrap();
    let one = json!({"verdicts": [{"index": 0, "refuted": false, "citedLineMatches": true, "reachable": true, "premiseSupported": true, "reason": "r"}]});
    let s = step::submit(&run, &answers(json!({"verify-batch:0": one}))).unwrap();
    assert!(
        s["tasks"][0]["prompt"]
            .as_str()
            .unwrap()
            .contains("no verdict for index 1")
    );
}

#[test]
fn an_answer_for_no_pending_task_is_refused_and_changes_nothing() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&opts(repo.path(), out.path())).unwrap();
    let err = step::submit(&run, &answers(json!({"verify:7": {}}))).unwrap_err();
    assert!(err.to_string().contains("verify:7"));
    assert_eq!(
        status::status(&run).unwrap()["tasks"][0]["retries"],
        json!(0)
    );
}

#[test]
fn a_lens_with_no_findings_and_a_diff_with_no_rust_both_approve() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&opts(repo.path(), out.path())).unwrap();
    let s = step::submit(
        &run,
        &answers(json!({"lens:intent": {"lens": "intent", "findings": []}})),
    )
    .unwrap();
    assert_eq!(s["verdict"], json!("Approve"));

    let repo = fixture(false);
    let out = tempfile::tempdir().unwrap();
    let s = step::start(&opts(repo.path(), out.path())).unwrap();
    assert_eq!(
        (s["done"].clone(), s["verdict"].clone()),
        (json!(true), json!("Approve"))
    );
}

#[test]
fn a_base_that_is_no_commit_is_refused() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let mut o = opts(repo.path(), out.path());
    o.base = Some("--output=/tmp/x".into());
    let err = step::start(&o).unwrap_err();
    assert!(err.to_string().contains("is not a commit"), "{err}");
    o.base = Some("nope".into());
    let err = step::start(&o).unwrap_err();
    assert!(err.to_string().contains("is not a commit"), "{err}");
}
