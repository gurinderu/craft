//! Fixtures the step-protocol tests share: a repository with a real git diff, and answers.
#![allow(dead_code, reason = "each test crate uses its own part of these")]
#![expect(
    clippy::unwrap_used,
    reason = "the fixture helpers fail the test loudly, like the tests they serve"
)]

use std::path::Path;
use std::process::Command;

use craft_review::step::{self, StartOptions};
use serde_json::{Map, Value, json};

pub fn git(dir: &Path, args: &[&str]) {
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
pub fn fixture(rust: bool) -> tempfile::TempDir {
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

pub fn opts(repo: &Path, run: &Path) -> StartOptions {
    StartOptions {
        cwd: repo.to_path_buf(),
        base: None,
        run_dir: run.join("run"),
        craft_root: Some("/craft".into()),
        craft_version: Some("9.9.9".into()),
        light: false,
        fresh: false,
        full_every: 0,
        runs: None,
        strict: false,
        prior_decisions: None,
        recall: false,
        sources: None,
        gate: None,
    }
}

pub fn answers(pairs: Value) -> Map<String, Value> {
    pairs.as_object().unwrap().clone()
}

pub fn finding(severity: &str, line: u32) -> Value {
    titled(severity, line, &format!("bad at {line}"))
}

/// A finding at `src/lib.rs:<line>` titled `title`.
pub fn titled(severity: &str, line: u32, title: &str) -> Value {
    json!({
        "severity": severity, "title": title, "file": "src/lib.rs", "line": line,
        "why": "wrong", "fix": "fix it", "blastRadius": "", "source": "intent", "ruleId": "",
        "whereChecked": "", "harmLevel": "intent-unmet", "harm": "callers get 1"
    })
}

pub fn verdict(refuted: bool) -> Value {
    json!({"refuted": refuted, "citedLineMatches": true, "reachable": true, "premiseSupported": true, "reason": "seen"})
}

pub fn ids(step: &Value) -> Vec<String> {
    step["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].as_str().unwrap().to_owned())
        .collect()
}

/// The prompt file a task of `step` names, read.
pub fn prompt_of(task: &Value) -> String {
    std::fs::read_to_string(task["promptFile"].as_str().unwrap()).unwrap()
}

/// Fails, naming the missing piece, unless `text` holds every one of `wants`.
#[track_caller]
pub fn assert_contains_all(text: &str, wants: &[&str]) {
    for want in wants {
        assert!(text.contains(want), "{want}: {text}");
    }
}

/// Writes `answer` where the task of `step` with `id` wants it, as its agent would.
pub fn write_answer(step: &Value, id: &str, answer: &str) {
    let task = step["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == json!(id))
        .unwrap();
    let path = Path::new(task["answerFile"].as_str().unwrap());
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, answer).unwrap();
}

/// A scout's answer: `size`, the picks `lenses`, not security-sensitive, one repository rule file.
pub fn scout(size: &str, lenses: &[&str]) -> Value {
    json!({"sizeBucket": size, "lenses": lenses, "isLibrary": false, "securitySensitive": false,
           "intent": "add f, which never fails", "churn": ["src/lib.rs"], "repoRules": ["AGENTS.md"], "notes": "n"})
}

/// A lens's answer of `findings`.
pub fn lens(name: &str, findings: &[Value]) -> Value {
    json!({"lens": name, "findings": findings})
}

/// Submits `pairs` (answers by task id) to the run in `run`.
pub fn submit(run: &Path, pairs: Value) -> Value {
    step::submit(run, Some(&answers(pairs))).unwrap()
}

/// Starts a run over `repo` and answers its scout with a small plan picking `errors`: the lenses
/// `errors`, `intent` and `tests`, one round. Returns the run directory and the lens step.
pub fn small_run(repo: &Path, out: &Path) -> (std::path::PathBuf, Value) {
    let run = out.join("run");
    step::start(&opts(repo, out)).unwrap();
    let s = submit(&run, json!({"scout-rust": scout("small", &["errors"])}));
    assert_eq!(
        ids(&s),
        [
            "lens-rust-errors-r1",
            "lens-rust-intent-r1",
            "lens-rust-tests-r1"
        ]
    );
    (run, s)
}
