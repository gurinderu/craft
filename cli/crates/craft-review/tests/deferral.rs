//! A deferred finding carried into the next round of its branch without an adjudicator when the
//! code under it is unchanged since its question's anchor — its date, or the merge of a pull
//! request it links, where the question names no commit (realm @nick/craft, node #680).
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the helpers of these tests fail loudly, like the tests they serve"
)]

mod common;

use std::path::Path;
use std::process::Command;

use common::{ids, lens, opts, scout, submit, titled};
use craft_review::step::{self, StartOptions};
use serde_json::{Value, json};

/// Runs git in `dir`, author and committer dated `date`, its stdout trimmed.
fn git(dir: &Path, date: &str, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .env("GIT_AUTHOR_DATE", date)
        .env("GIT_COMMITTER_DATE", date)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}");
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

const F: &str = "pub fn f() -> u8 { 1 }\n";

/// A first commit holding an empty `src/lib.rs` on 2026-05-01, its commit returned with the
/// repository.
fn first() -> (tempfile::TempDir, String) {
    let t = tempfile::tempdir().unwrap();
    let d = t.path();
    let at = "2026-05-01T08:00:00+0000";
    git(d, at, &["init", "-q", "-b", "main"]);
    let url = "https://github.com/Owner/Repo.git";
    git(d, at, &["remote", "add", "origin", url]);
    std::fs::write(d.join("README.md"), "x\n").unwrap();
    std::fs::create_dir_all(d.join("src")).unwrap();
    std::fs::write(d.join("src/lib.rs"), "").unwrap();
    git(d, at, &["add", "."]);
    git(d, at, &["commit", "-qm", "init"]);
    let base = git(d, at, &["rev-parse", "HEAD"]);
    (t, base)
}

/// `f` added on the trunk early on 2026-05-02, before a record of the 3rd began anywhere.
fn dated() -> (tempfile::TempDir, String) {
    let (t, base) = first();
    let d = t.path();
    let at = "2026-05-02T08:00:00+0000";
    std::fs::write(d.join("src/lib.rs"), F).unwrap();
    git(d, at, &["commit", "-qam", "feat: add f"]);
    git(d, at, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    (t, base)
}

/// `f` added by pull request #7, merged on the trunk, and `HEAD` on a branch off it.
fn merged() -> (tempfile::TempDir, String) {
    let (t, base) = first();
    let d = t.path();
    let opened = "2026-05-02T08:00:00+0000";
    git(d, opened, &["checkout", "-qb", "feat7"]);
    std::fs::write(d.join("src/lib.rs"), F).unwrap();
    git(d, opened, &["commit", "-qam", "feat: add f"]);
    git(d, opened, &["checkout", "-q", "main"]);
    let at = "2026-05-02T12:00:00+0000";
    let subject = "Merge pull request #7 from owner/feat7";
    git(d, at, &["merge", "-q", "--no-ff", "-m", subject, "feat7"]);
    git(d, at, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(d, at, &["checkout", "-qb", "feat"]);
    (t, base)
}

fn confirmed() -> Value {
    json!({"verdicts": [{"index": 0, "refuted": false, "citedLineMatches": true, "reachable": true,
        "premiseSupported": true, "behaviourIntended": false, "harmSupported": false,
        "confirmedHarmLevel": "none", "reason": "seen"}]})
}

/// Answers every task of `s` until the run is done: the scout picks `errors`, the recall finds
/// nothing, `errors` reports `found` in round 1, the verifier confirms it and each adjudicator
/// finds its prior still open.
fn drive(run: &Path, mut s: Value, found: &[Value]) -> Value {
    while s["done"] == json!(false) {
        let mut answers = serde_json::Map::new();
        for id in ids(&s) {
            let a = if id.starts_with("scout-") {
                scout("small", &["errors"])
            } else if id == "memory-recall" {
                json!({"backend": "none", "why": "no memory configured", "decisions": []})
            } else if let Some(rest) = id.strip_prefix("lens-rust-") {
                let name = rest.split('-').next().unwrap();
                lens(name, if name == "errors" { found } else { &[] })
            } else if id.starts_with("adjudicate-") {
                json!({"status": "still-open", "currentLine": 0, "note": "", "invariant": "i", "attack": ""})
            } else {
                assert_eq!(id, "verify-batch-0");
                confirmed()
            };
            answers.insert(id, a);
        }
        s = submit(run, Value::Object(answers));
    }
    s
}

/// Round 1 over `repo` from `base` defers its finding by `question`; after a commit elsewhere,
/// round 2 asks no adjudicator and carries the finding as Known and deferred.
fn carried_quietly(repo: &Path, base: &str, question: &Value) {
    let runs = tempfile::tempdir().unwrap();
    let start = |name: &str| StartOptions {
        run_dir: runs.path().join(name),
        base: Some(base.to_owned()),
        recall: true,
        prior_decisions: Some(Ok(json!([question]))),
        ..opts(repo, runs.path())
    };
    let found = [titled("Medium", 1, "retry budget of fetch is unbounded")];
    let one = drive(
        &runs.path().join("r1"),
        step::start(&start("r1")).unwrap(),
        &found,
    );
    let row = &one["ledger"][0];
    assert_eq!(
        (&row["disposition"], &row["deferral"]["id"]),
        (&json!("deferred"), &question["id"]),
        "{one}"
    );
    std::fs::write(repo.join("src/other.rs"), "pub fn g() {}\n").unwrap();
    git(repo, "2026-05-04T08:00:00+0000", &["add", "."]);
    git(
        repo,
        "2026-05-04T08:00:00+0000",
        &["commit", "-qm", "fix: g"],
    );
    let s = step::start(&start("r2")).unwrap();
    assert_eq!(ids(&s), ["scout-rust", "memory-recall"]);
    let two = drive(&runs.path().join("r2"), s, &[]);
    let report = std::fs::read_to_string(two["report"].as_str().unwrap()).unwrap();
    assert!(
        report.contains("Known and deferred (its question still holds)"),
        "{report}"
    );
}

#[test]
fn a_dated_deferral_whose_code_is_unchanged_since_its_date_needs_no_adjudicator() {
    let (repo, base) = dated();
    let question = json!({
        "id": "question-abcdef0123", "kind": "question", "title": "retry budget of fetch",
        "body": "decide after the load test", "scope": "src/lib.rs", "deferred": true,
        "date": "2026-05-03", "line": 1, "lens": "errors", "author": "nick"
    });
    carried_quietly(repo.path(), &base, &question);
}

#[test]
fn a_deferral_whose_pull_request_is_not_its_first_link_is_anchored_by_its_merge() {
    let (repo, base) = merged();
    let question = json!({
        "id": "question-abcdef0123", "kind": "question", "title": "retry budget of fetch",
        "body": "decide after the load test", "scope": "src/lib.rs", "deferred": true,
        "line": 1, "lens": "errors", "author": "nick",
        "links": ["https://github.com/owner/repo/issues/3", "https://github.com/owner/repo/pull/7"]
    });
    carried_quietly(repo.path(), &base, &question);
}
